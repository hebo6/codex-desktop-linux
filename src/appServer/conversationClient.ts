import type {
  ServerNotification,
  ThreadStartParams,
  ThreadStartResponse,
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
}

export interface ConversationClient {
  startThread(params?: ThreadStartParams): RequestHandle<ThreadStartResponse>;
  startTurn(threadId: string, options: StartTurnOptions): RequestHandle<TurnStartResponse>;
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

export class AppServerConversationClient implements ConversationClient {
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
    };
    return this.session.sendRequest({
      method: "turn/start",
      params,
      validateResult: turnStartResponseValidator,
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
