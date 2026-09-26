// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：36650394c5b38c2990ccf2a3457165ca3e9d9726

/**
 * Final buffered result for `command/exec`.
 */
export interface CommandExecResponse {
  /**
   * Process exit code.
   */
  exitCode: number;
  /**
   * Buffered stderr capture.
   *
   * Empty when stderr was streamed via `command/exec/outputDelta`.
   */
  stderr: string;
  /**
   * Buffered stdout capture.
   *
   * Empty when stdout was streamed via `command/exec/outputDelta`.
   */
  stdout: string;
  [k: string]: unknown | undefined;
}
