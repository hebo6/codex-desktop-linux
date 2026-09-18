import { useCallback, useEffect, useRef, useState } from "react";

import type { AppServerThreadClient } from "../appServer";
import type { ServerNotification, ThreadListResponse } from "../protocol/generated";
import {
  subAgentSummary,
  type ObservedSubAgent,
  type SubAgentSummary,
} from "./subAgentState";

export type SubAgentClient = Pick<
  AppServerThreadClient,
  "listSubAgentThreads" | "listLatestThreadTurn" | "subscribeNotifications"
>;
type Thread = ThreadListResponse["data"][number];

interface SubAgentState {
  readonly client: SubAgentClient | null;
  readonly threadId: string | null;
  readonly agents: readonly SubAgentSummary[];
  readonly error: string | null;
}

const EMPTY_AGENTS: readonly SubAgentSummary[] = [];

export function useSubAgents(
  client: SubAgentClient | null,
  thread: Pick<Thread, "id" | "sessionId"> | null,
) {
  const threadId = thread?.id ?? null;
  const sessionId = thread?.sessionId ?? null;
  const [state, setState] = useState<SubAgentState>({
    client: null, threadId: null, agents: EMPTY_AGENTS, error: null,
  });
  const refreshRef = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => refreshRef.current?.(), []);

  useEffect(() => {
    if (client === null || threadId === null) {
      return;
    }
    const target = client;
    const ancestorThreadId = threadId;
    let active = true;
    let deleted = false;
    let refreshing = false;
    let refreshAgain = false;
    let pendingNotifications: ServerNotification[] = [];
    const agents = new Map<string, ObservedSubAgent>();
    const errors = new Set<string>();
    const discoveredThreadIds = new Set<string>();

    function publish() {
      if (active) {
        setState({
          client,
          threadId,
          agents: [...agents.values()].map(subAgentSummary),
          error: errors.size === 0 ? null : "无法同步部分子 agent 状态",
        });
      }
    }

    async function loadLastTurn(agent: ObservedSubAgent) {
      const id = agent.thread.id;
      try {
        const response = await target.listLatestThreadTurn(id).result;
        if (!active || agents.get(id) !== agent) {
          return;
        }
        agents.set(id, {
          ...agent,
          lastTurnStatus: response.data[0]?.status ?? null,
        });
        errors.delete(id);
      } catch {
        if (!active || agents.get(id) !== agent) {
          return;
        }
        errors.add(id);
      }
      publish();
    }

    function upsert(thread: Thread) {
      const previous = agents.get(thread.id);
      const agent: ObservedSubAgent = {
        thread,
        lastTurnStatus: thread.status.type === "idle"
          ? previous?.lastTurnStatus ?? null
          : null,
      };
      agents.set(thread.id, agent);
      errors.delete(thread.id);
      if (thread.status.type === "idle") {
        void loadLastTurn(agent);
      }
    }

    function apply(notification: ServerNotification) {
      if (deleted) {
        return;
      }
      switch (notification.method) {
        case "thread/started": {
          const child = notification.params.thread;
          if (
            child.parentThreadId === threadId ||
            (child.parentThreadId != null && agents.has(child.parentThreadId))
          ) {
            upsert(child);
          }
          break;
        }
        case "thread/status/changed": {
          const { threadId: id, status } = notification.params;
          const agent = agents.get(id);
          if (agent !== undefined) {
            upsert({ ...agent.thread, status });
          }
          break;
        }
        case "thread/closed":
        case "thread/deleted": {
          const id = notification.params.threadId;
          if (id === threadId && notification.method === "thread/deleted") {
            deleted = true;
            agents.clear();
            errors.clear();
          } else if (notification.method === "thread/deleted") {
            agents.delete(id);
            errors.delete(id);
          } else {
            const agent = agents.get(id);
            if (agent !== undefined) {
              upsert({ ...agent.thread, status: { type: "notLoaded" } });
            }
          }
          break;
        }
      }
    }

    async function refreshAgents() {
      if (deleted) {
        return;
      }
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      pendingNotifications = [];
      try {
        let cursor: string | null = null;
        const snapshot: Thread[] = [];
        do {
          const response: ThreadListResponse = await target.listSubAgentThreads(ancestorThreadId, cursor).result;
          if (!active || deleted) {
            return;
          }
          snapshot.push(...response.data);
          cursor = response.nextCursor ?? null;
        } while (cursor !== null);
        // 快照读取期间的通知按到达顺序重放，避免旧快照覆盖实时状态
        const snapshotIds = new Set(snapshot.map(({ id }) => id));
        for (const [id, agent] of agents) {
          if (!snapshotIds.has(id) && !agent.thread.ephemeral) {
            agents.delete(id);
            errors.delete(id);
          }
        }
        for (const child of snapshot) {
          upsert(child);
        }
        errors.delete(ancestorThreadId);
        for (const notification of pendingNotifications) {
          apply(notification);
        }
      } catch {
        if (active && !deleted) {
          errors.add(ancestorThreadId);
        }
      } finally {
        refreshing = false;
        pendingNotifications = [];
        publish();
        if (active && refreshAgain) {
          refreshAgain = false;
          void refreshAgents();
        }
      }
    }

    const release = client.subscribeNotifications((notification) => {
      if (!active || deleted) {
        return;
      }
      if (
        notification.method === "thread/started" ||
        notification.method === "thread/status/changed" ||
        notification.method === "thread/closed" ||
        notification.method === "thread/deleted"
      ) {
        if (refreshing) {
          pendingNotifications.push(notification);
        }
        apply(notification);
        publish();
      }
      if (
        notification.method === "thread/started" &&
        notification.params.thread.sessionId === sessionId &&
        notification.params.thread.parentThreadId != null
      ) {
        void refreshAgents();
      }
      // 子 agent 的回合事件不一定路由到父会话；全局状态通知仍会到达
      // 对首次出现的活动线程查询后代关系，由服务端筛选，避免漏掉嵌套 agent
      if (
        notification.method === "thread/status/changed" &&
        notification.params.status.type === "active" &&
        notification.params.threadId !== threadId &&
        !agents.has(notification.params.threadId) &&
        !discoveredThreadIds.has(notification.params.threadId)
      ) {
        discoveredThreadIds.add(notification.params.threadId);
        void refreshAgents();
      }
      if (
        notification.method === "item/completed" &&
        (notification.params.threadId === threadId || agents.has(notification.params.threadId))
      ) {
        const item = notification.params.item;
        if (
          (item.type === "subAgentActivity" && item.kind === "started") ||
          (item.type === "collabAgentToolCall" &&
            (item.tool === "spawnAgent" || item.tool === "resumeAgent"))
        ) {
          void refreshAgents();
        }
      }
    });
    refreshRef.current = () => { void refreshAgents(); };
    publish();
    void refreshAgents();
    return () => {
      active = false;
      refreshRef.current = null;
      release();
    };
  }, [client, threadId, sessionId]);

  const current = state.client === client && state.threadId === threadId;
  return {
    agents: current ? state.agents : EMPTY_AGENTS,
    error: current ? state.error : null,
    refresh,
  };
}
