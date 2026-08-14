// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：8630bb3caecaff6abc6add450a88035d9f6d3f8c

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
