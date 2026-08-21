// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：657bd889ae28edcbf5395c103b479bf8b328704e

export type ThreadUnsubscribeStatus = "notLoaded" | "notSubscribed" | "unsubscribed";

export interface ThreadUnsubscribeResponse {
  status: ThreadUnsubscribeStatus;
  [k: string]: unknown | undefined;
}
