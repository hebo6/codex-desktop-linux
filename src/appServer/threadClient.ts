import type {
  ServerNotification,
  ThreadListParams,
  ThreadListResponse,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadTurnsListParams,
  ThreadTurnsListResponse,
  ThreadUnsubscribeParams,
  ThreadUnsubscribeResponse,
  ThreadArchiveParams,
  ThreadArchiveResponse,
  ThreadUnarchiveParams,
  ThreadUnarchiveResponse,
  ThreadDeleteParams,
  ThreadDeleteResponse,
  ThreadForkParams,
  ThreadForkResponse,
} from "../protocol/generated";
import type {
  RequestHandle,
  ResultValidator,
  ServerNotificationHandler,
} from "../protocol/rpc";
import {
  validateThreadListResponse,
  validateThreadReadResponse,
  validateThreadResumeResponse,
  validateThreadTurnsListResponse,
  validateThreadUnsubscribeResponse,
  validateThreadArchiveResponse,
  validateThreadUnarchiveResponse,
  validateThreadDeleteResponse,
  validateThreadForkResponse,
} from "../protocol/validation";
import type { AppServerSession } from "./session";

export const RECENT_THREAD_PAGE_SIZE = 50;
export const HISTORY_TURN_PAGE_SIZE = 30;

export interface RecentThreadPageOptions {
  readonly archived?: boolean;
  readonly cursor?: string | null;
}

export class AppServerThreadClient {
  constructor(
    private readonly session: Pick<
      AppServerSession,
      "sendRequest" | "subscribeNotifications"
    >,
  ) {}

  subscribeNotifications(
    handler: (notification: ServerNotification) => void,
  ): () => void {
    const notificationHandler: ServerNotificationHandler = handler;
    return this.session.subscribeNotifications(notificationHandler);
  }

  listRecentThreads(
    options: RecentThreadPageOptions = {},
  ): RequestHandle<ThreadListResponse> {
    const params: ThreadListParams = {
      archived: options.archived ?? false,
      limit: RECENT_THREAD_PAGE_SIZE,
      sortDirection: "desc",
      sortKey: "updated_at",
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    };
    return this.session.sendRequest({
      method: "thread/list",
      params,
      validateResult: threadListResponseValidator,
    });
  }

  readThread(
    threadId: string,
    includeTurns = false,
  ): RequestHandle<ThreadReadResponse> {
    const params: ThreadReadParams = { threadId, includeTurns };
    return this.session.sendRequest({
      method: "thread/read",
      params,
      validateResult: threadReadResponseValidator,
    });
  }

  resumeThread(threadId: string): RequestHandle<ThreadResumeResponse> {
    const params: ThreadResumeParams = {
      threadId,
      excludeTurns: true,
      initialTurnsPage: {
        itemsView: "full",
        limit: HISTORY_TURN_PAGE_SIZE,
        sortDirection: "desc",
      },
    };
    return this.session.sendRequest({
      method: "thread/resume",
      params,
      validateResult: threadResumeResponseValidator,
    });
  }

  listOlderTurns(
    threadId: string,
    cursor: string,
  ): RequestHandle<ThreadTurnsListResponse> {
    const params: ThreadTurnsListParams = {
      threadId,
      cursor,
      itemsView: "full",
      limit: HISTORY_TURN_PAGE_SIZE,
      sortDirection: "desc",
    };
    return this.session.sendRequest({
      method: "thread/turns/list",
      params,
      validateResult: threadTurnsListResponseValidator,
    });
  }

  unsubscribeThread(threadId: string): RequestHandle<ThreadUnsubscribeResponse> {
    const params: ThreadUnsubscribeParams = { threadId };
    return this.session.sendRequest({
      method: "thread/unsubscribe",
      params,
      validateResult: threadUnsubscribeResponseValidator,
    });
  }

  archiveThread(threadId: string): RequestHandle<ThreadArchiveResponse> {
    const params: ThreadArchiveParams = { threadId };
    return this.session.sendRequest({
      method: "thread/archive",
      params,
      validateResult: threadArchiveResponseValidator,
    });
  }

  unarchiveThread(threadId: string): RequestHandle<ThreadUnarchiveResponse> {
    const params: ThreadUnarchiveParams = { threadId };
    return this.session.sendRequest({
      method: "thread/unarchive",
      params,
      validateResult: threadUnarchiveResponseValidator,
    });
  }

  deleteThread(threadId: string): RequestHandle<ThreadDeleteResponse> {
    const params: ThreadDeleteParams = { threadId };
    return this.session.sendRequest({
      method: "thread/delete",
      params,
      validateResult: threadDeleteResponseValidator,
    });
  }

  forkThread(threadId: string, lastTurnId: string): RequestHandle<ThreadForkResponse> {
    const params: ThreadForkParams = {
      threadId,
      lastTurnId,
      excludeTurns: true,
    };
    return this.session.sendRequest({
      method: "thread/fork",
      params,
      validateResult: threadForkResponseValidator,
    });
  }
}

const threadListResponseValidator: ResultValidator<ThreadListResponse> =
  validateThreadListResponse;
const threadReadResponseValidator: ResultValidator<ThreadReadResponse> =
  validateThreadReadResponse;
const threadResumeResponseValidator: ResultValidator<ThreadResumeResponse> =
  validateThreadResumeResponse;
const threadTurnsListResponseValidator: ResultValidator<ThreadTurnsListResponse> =
  validateThreadTurnsListResponse;
const threadUnsubscribeResponseValidator: ResultValidator<ThreadUnsubscribeResponse> =
  validateThreadUnsubscribeResponse;
const threadArchiveResponseValidator: ResultValidator<ThreadArchiveResponse> =
  validateThreadArchiveResponse;
const threadUnarchiveResponseValidator: ResultValidator<ThreadUnarchiveResponse> =
  validateThreadUnarchiveResponse;
const threadDeleteResponseValidator: ResultValidator<ThreadDeleteResponse> =
  validateThreadDeleteResponse;
const threadForkResponseValidator: ResultValidator<ThreadForkResponse> =
  validateThreadForkResponse;
