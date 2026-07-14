// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export type McpServerElicitationAction = "accept" | "decline" | "cancel";

export interface McpServerElicitationRequestResponse {
  /**
   * Optional client metadata for form-mode action handling.
   */
  _meta?: {
    [k: string]: unknown | undefined;
  };
  action: McpServerElicitationAction;
  /**
   * Structured user input for accepted elicitations, mirroring RMCP `CreateElicitationResult`.
   *
   * This is nullable because decline/cancel responses have no content.
   */
  content?: {
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
