// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex CLI 版本：codex-cli 0.157.1

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
