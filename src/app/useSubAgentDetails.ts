import { useCallback, useEffect, useRef, useState } from "react";

import type { AppServerThreadClient } from "../appServer";
import type { Turn } from "../protocol/generated/types/ThreadTurnsListResponse";
import type { SubAgentStatus } from "./subAgentState";

export type SubAgentDetailsClient = Pick<AppServerThreadClient, "listLatestThreadTurn">;

interface DetailsState {
  readonly client: SubAgentDetailsClient | null;
  readonly threadId: string;
  readonly status: SubAgentStatus;
  readonly turn: Turn | null;
  readonly loading: boolean;
  readonly error: string | null;
}

const REFRESH_INTERVAL_MS = 5_000;

export function useSubAgentDetails(
  client: SubAgentDetailsClient | null,
  threadId: string,
  status: SubAgentStatus,
  enabled: boolean,
) {
  const [state, setState] = useState<DetailsState | null>(null);
  const snapshotRef = useRef<DetailsState | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => refreshRef.current?.(), []);

  useEffect(() => {
    if (client === null || !enabled) {
      return;
    }
    const target = client;
    const previous = snapshotRef.current;
    let active = true;
    let loading = false;
    let turn = previous?.client === client && previous.threadId === threadId &&
      previous.status === status ? previous.turn : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = status === "running" || status === "waitingOnApproval" ||
      status === "waitingOnUserInput";

    async function load() {
      if (!active || loading) {
        return;
      }
      clearTimeout(timer);
      loading = true;
      setState({ client, threadId, status, turn, loading: true, error: null });
      let error: string | null = null;
      try {
        const response = await target.listLatestThreadTurn(threadId, "summary").result;
        if (!active) {
          return;
        }
        turn = response.data[0] ?? null;
      } catch {
        error = "无法读取子 agent 详情";
      } finally {
        loading = false;
        if (active) {
          const next = { client, threadId, status, turn, loading: false, error };
          snapshotRef.current = next;
          setState(next);
          // 子线程内容通知不保证路由到父会话，仅在详情可见且 agent 活跃时刷新摘要
          if (running) {
            timer = setTimeout(() => { void load(); }, REFRESH_INTERVAL_MS);
          }
        }
      }
    }

    refreshRef.current = () => { void load(); };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
      refreshRef.current = null;
    };
  }, [client, threadId, status, enabled]);

  const current = client !== null && state?.client === client &&
    state.threadId === threadId && state.status === status;
  return {
    turn: current ? state.turn : null,
    loading: enabled && (current ? state.loading : client !== null),
    error: current ? state.error : null,
    refresh,
  };
}
