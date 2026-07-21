import type {
  ConsumeAccountRateLimitResetCreditParams,
  ConsumeAccountRateLimitResetCreditResponse,
  GetAccountRateLimitsResponse,
  ServerNotification,
} from "../protocol/generated";
import type { RequestHandle, ResultValidator } from "../protocol/rpc";
import {
  validateConsumeAccountRateLimitResetCreditResponse,
  validateGetAccountRateLimitsResponse,
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
}

const getAccountRateLimitsResponseValidator: ResultValidator<GetAccountRateLimitsResponse> =
  validateGetAccountRateLimitsResponse;
