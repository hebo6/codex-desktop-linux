// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：a4535884169be8da2f81b8a4debecbd4dc11aa97

export type ClientNotification = InitializedNotification;
export type InitializedNotificationMethod = "initialized";

export interface InitializedNotification {
  method: InitializedNotificationMethod;
  [k: string]: unknown | undefined;
}
