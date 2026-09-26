// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：36650394c5b38c2990ccf2a3457165ca3e9d9726

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
