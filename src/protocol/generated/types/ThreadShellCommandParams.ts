// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：36650394c5b38c2990ccf2a3457165ca3e9d9726

export interface ThreadShellCommandParams {
  /**
   * Shell command string evaluated by the thread's configured shell. Unlike `command/exec`, this intentionally preserves shell syntax such as pipes, redirects, and quoting. This runs unsandboxed with full access rather than inheriting the thread sandbox policy.
   */
  command: string;
  threadId: string;
  /**
   * Maximum execution time in milliseconds. Defaults to one hour when omitted or null. Must be non-negative; zero requests an immediate timeout, not unlimited execution. Does not affect the immediate RPC acknowledgement.
   */
  timeoutMs?: number | null;
  [k: string]: unknown | undefined;
}
