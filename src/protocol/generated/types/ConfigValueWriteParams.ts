// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：36650394c5b38c2990ccf2a3457165ca3e9d9726

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
