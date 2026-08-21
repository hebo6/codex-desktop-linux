// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：657bd889ae28edcbf5395c103b479bf8b328704e

export type MergeStrategy = "replace" | "upsert";

export interface ConfigValueWriteParams {
  expectedVersion?: string | null;
  /**
   * Path to the config file to write; defaults to the user's `config.toml` when omitted.
   */
  filePath?: string | null;
  keyPath: string;
  mergeStrategy: MergeStrategy;
  value: unknown;
  [k: string]: unknown | undefined;
}
