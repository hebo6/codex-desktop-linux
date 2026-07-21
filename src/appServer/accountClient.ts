import type {
  ConsumeAccountRateLimitResetCreditParams,
  ConsumeAccountRateLimitResetCreditResponse,
  GetAccountRateLimitsResponse,
  GetAccountTokenUsageResponse,
  ServerNotification,
} from "../protocol/generated";
import type { RequestHandle, ResultValidator } from "../protocol/rpc";
import {
  validateConsumeAccountRateLimitResetCreditResponse,
  validateGetAccountRateLimitsResponse,
  validateGetAccountTokenUsageResponse,
} from "../protocol/validation";
import type { AppServerSession } from "./session";
type RateLimitsNotification = Extract<
  ServerNotification,
  { method: "account/rateLimits/updated" }
>;

type AccountSession = Pick<AppServerSession, "sendRequest" | "subscribeNotifications">;

export interface AccountClient {
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

const getAccountRateLimitsResponseValidator: ResultValidator<GetAccountRateLimitsResponse> =
  validateGetAccountRateLimitsResponse;

const getAccountTokenUsageResponseValidator: ResultValidator<GetAccountTokenUsageResponse> =
  validateGetAccountTokenUsageResponse;
