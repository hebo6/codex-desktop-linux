import type {
  GetAccountRateLimitsResponse,
  ServerNotification,
} from "../protocol/generated";
import type { RequestHandle, ResultValidator } from "../protocol/rpc";
import { validateGetAccountRateLimitsResponse } from "../protocol/validation";
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
}

const getAccountRateLimitsResponseValidator: ResultValidator<GetAccountRateLimitsResponse> =
  validateGetAccountRateLimitsResponse;
