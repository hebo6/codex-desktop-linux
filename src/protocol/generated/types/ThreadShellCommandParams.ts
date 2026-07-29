// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：a4535884169be8da2f81b8a4debecbd4dc11aa97

export interface ThreadShellCommandParams {
  /**
   * Shell command string evaluated by the thread's configured shell. Unlike `command/exec`, this intentionally preserves shell syntax such as pipes, redirects, and quoting. This runs unsandboxed with full access rather than inheriting the thread sandbox policy.
   */
  command: string;
  threadId: string;
  [k: string]: unknown | undefined;
}
