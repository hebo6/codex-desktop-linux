// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex CLI 版本：codex-cli 0.157.1

export type ThreadUnsubscribeStatus = "notLoaded" | "notSubscribed" | "unsubscribed";

export interface ThreadUnsubscribeResponse {
  status: ThreadUnsubscribeStatus;
  [k: string]: unknown | undefined;
}
