import type {
  ConsumeAccountRateLimitResetCreditParams,
  ConsumeAccountRateLimitResetCreditResponse,
  GetAccountResponse,
  GetAccountRateLimitsResponse,
  GetAccountTokenUsageResponse,
  ServerNotification,
} from "../protocol/generated";
import type { RequestHandle, ResultValidator } from "../protocol/rpc";
import {
  validateConsumeAccountRateLimitResetCreditResponse,
  validateGetAccountResponse,
  validateGetAccountRateLimitsResponse,
  validateGetAccountTokenUsageResponse,
} from "../protocol/validation";
import type { AppServerSession } from "./session";
type RateLimitsNotification = Extract<
  ServerNotification,
  { method: "account/rateLimits/updated" }
>;
type AccountUpdatedNotification = Extract<
  ServerNotification,
  { method: "account/updated" }
>;

type AccountSession = Pick<AppServerSession, "sendRequest" | "subscribeNotifications">;

export interface AccountClient {
  readAccount(): RequestHandle<GetAccountResponse>;
  subscribeAccountUpdates(
    handler: (notification: AccountUpdatedNotification) => void,
  ): () => void;
  readRateLimits(): RequestHandle<GetAccountRateLimitsResponse>;
  subscribeRateLimitUpdates(
    handler: (notification: RateLimitsNotification) => void,
  ): () => void;
  consumeRateLimitResetCredit(
    params: ConsumeAccountRateLimitResetCreditParams,
  ): RequestHandle<ConsumeAccountRateLimitResetCreditResponse>;
  readTokenUsage(): RequestHandle<GetAccountTokenUsageResponse>;
}

export class AppServerAccountClient implements AccountClient {
  constructor(private readonly session: AccountSession) {}

  readAccount(): RequestHandle<GetAccountResponse> {
    return this.session.sendRequest({
      method: "account/read",
      params: {},
      validateResult: getAccountResponseValidator,
    });
  }

  subscribeAccountUpdates(
    handler: (notification: AccountUpdatedNotification) => void,
  ): () => void {
    return this.session.subscribeNotifications((notification) => {
      if (notification.method === "account/updated") {
        handler(notification);
      }
    });
  }

  readRateLimits(): RequestHandle<GetAccountRateLimitsResponse> {
    return this.session.sendRequest({
      method: "account/rateLimits/read",
      validateResult: getAccountRateLimitsResponseValidator,
    });
  }

  subscribeRateLimitUpdates(
    handler: (notification: RateLimitsNotification) => void,
  ): () => void {
    return this.session.subscribeNotifications((notification) => {
      if (notification.method === "account/rateLimits/updated") {
        handler(notification);
      }
    });
  }

  consumeRateLimitResetCredit(
    params: ConsumeAccountRateLimitResetCreditParams,
  ): RequestHandle<ConsumeAccountRateLimitResetCreditResponse> {
    return this.session.sendRequest({
      method: "account/rateLimitResetCredit/consume",
      params,
      validateResult: validateConsumeAccountRateLimitResetCreditResponse,
    });
  }

  readTokenUsage(): RequestHandle<GetAccountTokenUsageResponse> {
    return this.session.sendRequest({
      method: "account/usage/read",
      validateResult: getAccountTokenUsageResponseValidator,
    });
  }
}

const getAccountResponseValidator: ResultValidator<GetAccountResponse> =
  validateGetAccountResponse;

const getAccountRateLimitsResponseValidator: ResultValidator<GetAccountRateLimitsResponse> =
  validateGetAccountRateLimitsResponse;

const getAccountTokenUsageResponseValidator: ResultValidator<GetAccountTokenUsageResponse> =
  validateGetAccountTokenUsageResponse;
