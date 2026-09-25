import type { ProjectListResponse, ThreadQueueListResponse } from "../protocol/generated";
import {
  validateProjectListResponse,
  validateThreadGoalGetResponse,
  validateThreadQueueListResponse,
} from "../protocol/validation";
import type { AppServerSession } from "./session";
import { SERVER_EVENT_LIMITS, type ServerEventStore } from "./serverEventState";

type EventSession = Pick<AppServerSession, "sendRequest" | "subscribeNotifications">;

/** 通知中的失效信号触发只读查询；回复只能归并到发起时的版本 */
export class ServerEventSync {
  private disposed = false;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly goals = new Map<string, Promise<void>>();
  private projects: Promise<void> | null = null;
  private readonly release: () => void;

  constructor(private readonly session: EventSession, private readonly store: ServerEventStore) {
    // session 在此订阅前已更新 store，查询总是观察到通知的新版本
    this.release = session.subscribeNotifications((notification) => {
      switch (notification.method) {
        case "thread/queue/changed":
          void this.refreshQueue(notification.params.threadId);
          break;
        case "project/changed":
          void this.refreshProjects();
          break;
      }
    });
  }

  readonly restoreThread = (threadId: string): void => {
    void this.refreshQueue(threadId);
    void this.refreshGoal(threadId);
  };

  refreshQueue(threadId: string): Promise<void> {
    const pending = this.queues.get(threadId);
    if (pending !== undefined) return pending;
    const task = this.readQueue(threadId).finally(() => this.queues.delete(threadId));
    this.queues.set(threadId, task);
    return task;
  }

  private async readQueue(threadId: string): Promise<void> {
    while (this.canSyncThread(threadId)) {
      const version = this.store.getSnapshot().queueVersionsByThread[threadId] ?? 0;
      try {
        const data: ThreadQueueListResponse["data"] = [];
        let cursor: string | null = null;
        const cursors = new Set<string>();
        do {
          const response: ThreadQueueListResponse = await this.session.sendRequest({
            method: "thread/queue/list",
            params: { threadId, limit: 100, ...(cursor === null ? {} : { cursor }) },
            validateResult: validateThreadQueueListResponse,
          }).result;
          if (!this.canSyncThread(threadId)) return;
          data.push(...response.data.slice(0, SERVER_EVENT_LIMITS.entities + 1 - data.length));
          cursor = response.nextCursor ?? null;
          if (cursor !== null) {
            if (cursors.has(cursor)) throw new Error("重复的队列分页游标");
            cursors.add(cursor);
          }
        } while (cursor !== null && data.length <= SERVER_EVENT_LIMITS.entities);
        if (version !== (this.store.getSnapshot().queueVersionsByThread[threadId] ?? 0)) continue;
        this.store.hydrateQueue(threadId, version, data);
      } catch {
        if (!this.canSyncThread(threadId)) return;
        if (version !== (this.store.getSnapshot().queueVersionsByThread[threadId] ?? 0)) continue;
        this.store.failQueue(threadId, version, "无法同步待发送队列");
      }
      return;
    }
  }

  refreshGoal(threadId: string): Promise<void> {
    if (!this.canSyncThread(threadId)) return Promise.resolve();
    const pending = this.goals.get(threadId);
    if (pending !== undefined) return pending;
    const task = (async () => {
      while (this.canSyncThread(threadId)) {
        const version = this.store.getSnapshot().goalVersionsByThread[threadId] ?? 0;
        try {
          const result = await this.session.sendRequest({
            method: "thread/goal/get",
            params: { threadId },
            validateResult: validateThreadGoalGetResponse,
          }).result;
          if (!this.canSyncThread(threadId)) return;
          if (version !== (this.store.getSnapshot().goalVersionsByThread[threadId] ?? 0)) {
            if (this.store.getSnapshot().goalsByThread[threadId]?.stale === false) return;
            continue;
          }
          this.store.hydrateGoal(threadId, version, result.goal ?? null);
        } catch {
          if (!this.canSyncThread(threadId)) return;
          if (version !== (this.store.getSnapshot().goalVersionsByThread[threadId] ?? 0)) {
            if (this.store.getSnapshot().goalsByThread[threadId]?.stale === false) return;
            continue;
          }
          this.store.failGoal(threadId, version, "无法同步会话目标");
        }
        return;
      }
    })().finally(() => this.goals.delete(threadId));
    this.goals.set(threadId, task);
    return task;
  }

  refreshProjects(): Promise<void> {
    if (this.projects !== null) return this.projects;
    this.projects = this.readProjects().finally(() => { this.projects = null; });
    return this.projects;
  }

  private async readProjects(): Promise<void> {
    while (!this.disposed && this.store.getSnapshot().connected) {
      const version = this.store.getSnapshot().projectVersion;
      try {
        const data: ProjectListResponse["data"] = [];
        let cursor: string | null = null;
        const cursors = new Set<string>();
        do {
          const response: ProjectListResponse = await this.session.sendRequest({
            method: "project/list",
            params: { limit: 100, ...(cursor === null ? {} : { cursor }) },
            validateResult: validateProjectListResponse,
          }).result;
          if (this.disposed || !this.store.getSnapshot().connected) return;
          data.push(...response.data.slice(0, SERVER_EVENT_LIMITS.entities + 1 - data.length));
          cursor = response.nextCursor ?? null;
          if (cursor !== null) {
            if (cursors.has(cursor)) throw new Error("重复的项目分页游标");
            cursors.add(cursor);
          }
        } while (cursor !== null && data.length <= SERVER_EVENT_LIMITS.entities);
        if (version !== this.store.getSnapshot().projectVersion) continue;
        this.store.hydrateProjects(version, data);
      } catch {
        if (this.disposed) return;
        if (version !== this.store.getSnapshot().projectVersion) continue;
        this.store.failProjects(version, "无法同步服务器项目列表");
      }
      return;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.release();
  }

  private canSyncThread(threadId: string): boolean {
    const state = this.store.getSnapshot();
    return !this.disposed && state.connected && !state.deletedThreadIds.includes(threadId);
  }
}
