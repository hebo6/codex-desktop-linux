import type {
  ServerNotification,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadSettingsUpdateParams,
  ThreadSettingsUpdateResponse,
  ThreadBackgroundTerminalsListParams,
  ThreadBackgroundTerminalsListResponse,
  ThreadBackgroundTerminalsTerminateParams,
  ThreadBackgroundTerminalsTerminateResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
  ThreadCompactStartResponse,
  ReviewStartResponse,
} from "../protocol/generated";
import type {
  RequestHandle,
  ResultValidator,
  ServerNotificationHandler,
} from "../protocol/rpc";
import {
  validateThreadStartResponse,
  validateThreadSettingsUpdateResponse,
  validateThreadBackgroundTerminalsListResponse,
  validateThreadBackgroundTerminalsTerminateResponse,
  validateTurnInterruptResponse,
  validateTurnStartResponse,
  validateTurnSteerResponse,
  validateThreadCompactStartResponse,
  validateReviewStartResponse,
} from "../protocol/validation";
import type { AppServerSession } from "./session";

type ConversationSession = Pick<
  AppServerSession,
  "sendRequest" | "subscribeNotifications"
>;

export interface StartTurnOptions {
  readonly clientUserMessageId: string;
  readonly input: TurnStartParams["input"];
  readonly cwd?: TurnStartParams["cwd"];
  readonly effort?: TurnStartParams["effort"];
  readonly model?: TurnStartParams["model"];
  readonly permissions?: TurnStartParams["permissions"];
  readonly serviceTier?: TurnStartParams["serviceTier"];
}

export interface ConversationClient {
  startThread(params?: ThreadStartParams): RequestHandle<ThreadStartResponse>;
  startTurn(threadId: string, options: StartTurnOptions): RequestHandle<TurnStartResponse>;
  setServiceTier(
    threadId: string,
    serviceTier: string,
  ): RequestHandle<ThreadSettingsUpdateResponse>;
  steerTurn(
    threadId: string,
    expectedTurnId: string,
    options: StartTurnOptions,
  ): RequestHandle<TurnSteerResponse>;
  interruptTurn(threadId: string, turnId: string): RequestHandle<TurnInterruptResponse>;
  compactThread(threadId: string): RequestHandle<ThreadCompactStartResponse>;
  reviewUncommittedChanges(threadId: string): RequestHandle<ReviewStartResponse>;
  subscribeNotifications(handler: (notification: ServerNotification) => void): () => void;
}

export interface BackgroundTerminalClient {
  listBackgroundTerminals(
    threadId: string,
    cursor?: string | null,
  ): RequestHandle<ThreadBackgroundTerminalsListResponse>;
  terminateBackgroundTerminal(
    threadId: string,
    processId: string,
  ): RequestHandle<ThreadBackgroundTerminalsTerminateResponse>;
  subscribeNotifications(handler: (notification: ServerNotification) => void): () => void;
}

export class AppServerConversationClient
  implements ConversationClient, BackgroundTerminalClient {
  constructor(private readonly session: ConversationSession) {}

  startThread(params: ThreadStartParams = {}): RequestHandle<ThreadStartResponse> {
    return this.session.sendRequest({
      method: "thread/start",
      params,
      validateResult: threadStartResponseValidator,
    });
  }

  startTurn(threadId: string, options: StartTurnOptions): RequestHandle<TurnStartResponse> {
    const params: TurnStartParams = {
      threadId,
      clientUserMessageId: options.clientUserMessageId,
      input: options.input,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
      ...(options.serviceTier === undefined ? {} : { serviceTier: options.serviceTier }),
    };
    return this.session.sendRequest({
      method: "turn/start",
      params,
      validateResult: turnStartResponseValidator,
    });
  }

  setServiceTier(
    threadId: string,
    serviceTier: string,
  ): RequestHandle<ThreadSettingsUpdateResponse> {
    const params: ThreadSettingsUpdateParams = { threadId, serviceTier };
    return this.session.sendRequest({
      method: "thread/settings/update",
      params,
      validateResult: threadSettingsUpdateResponseValidator,
    });
  }

  listBackgroundTerminals(
    threadId: string,
    cursor?: string | null,
  ): RequestHandle<ThreadBackgroundTerminalsListResponse> {
    const params: ThreadBackgroundTerminalsListParams = {
      threadId,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    };
    return this.session.sendRequest({
      method: "thread/backgroundTerminals/list",
      params,
      validateResult: threadBackgroundTerminalsListResponseValidator,
    });
  }

  terminateBackgroundTerminal(
    threadId: string,
    processId: string,
  ): RequestHandle<ThreadBackgroundTerminalsTerminateResponse> {
    const params: ThreadBackgroundTerminalsTerminateParams = {
      threadId,
      processId,
    };
    return this.session.sendRequest({
      method: "thread/backgroundTerminals/terminate",
      params,
      validateResult: threadBackgroundTerminalsTerminateResponseValidator,
    });
  }

  steerTurn(
    threadId: string,
    expectedTurnId: string,
    options: StartTurnOptions,
  ): RequestHandle<TurnSteerResponse> {
    const params: TurnSteerParams = {
      threadId,
      expectedTurnId,
      clientUserMessageId: options.clientUserMessageId,
      input: options.input,
    };
    return this.session.sendRequest({
      method: "turn/steer",
      params,
      validateResult: turnSteerResponseValidator,
    });
  }

  interruptTurn(threadId: string, turnId: string): RequestHandle<TurnInterruptResponse> {
    const params: TurnInterruptParams = { threadId, turnId };
    return this.session.sendRequest({
      method: "turn/interrupt",
      params,
      validateResult: turnInterruptResponseValidator,
    });
  }

  compactThread(threadId: string): RequestHandle<ThreadCompactStartResponse> {
    return this.session.sendRequest({
      method: "thread/compact/start",
      params: { threadId },
      validateResult: threadCompactStartResponseValidator,
    });
  }

  reviewUncommittedChanges(threadId: string): RequestHandle<ReviewStartResponse> {
    return this.session.sendRequest({
      method: "review/start",
      params: { threadId, delivery: "inline", target: { type: "uncommittedChanges" } },
      validateResult: reviewStartResponseValidator,
    });
  }

  subscribeNotifications(handler: (notification: ServerNotification) => void): () => void {
    const notificationHandler: ServerNotificationHandler = handler;
    return this.session.subscribeNotifications(notificationHandler);
  }
}

const threadStartResponseValidator: ResultValidator<ThreadStartResponse> =
  validateThreadStartResponse;
const threadSettingsUpdateResponseValidator: ResultValidator<ThreadSettingsUpdateResponse> =
  validateThreadSettingsUpdateResponse;
const threadBackgroundTerminalsListResponseValidator: ResultValidator<ThreadBackgroundTerminalsListResponse> =
  validateThreadBackgroundTerminalsListResponse;
const threadBackgroundTerminalsTerminateResponseValidator: ResultValidator<ThreadBackgroundTerminalsTerminateResponse> =
  validateThreadBackgroundTerminalsTerminateResponse;
const turnStartResponseValidator: ResultValidator<TurnStartResponse> =
  validateTurnStartResponse;
const turnSteerResponseValidator: ResultValidator<TurnSteerResponse> =
  validateTurnSteerResponse;
const turnInterruptResponseValidator: ResultValidator<TurnInterruptResponse> =
  validateTurnInterruptResponse;
const threadCompactStartResponseValidator: ResultValidator<ThreadCompactStartResponse> =
  validateThreadCompactStartResponse;
const reviewStartResponseValidator: ResultValidator<ReviewStartResponse> =
  validateReviewStartResponse;
