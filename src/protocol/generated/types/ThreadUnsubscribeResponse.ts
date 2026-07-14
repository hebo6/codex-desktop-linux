// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export type ThreadUnsubscribeStatus = "notLoaded" | "notSubscribed" | "unsubscribed";

export interface ThreadUnsubscribeResponse {
  status: ThreadUnsubscribeStatus;
  [k: string]: unknown | undefined;
}
