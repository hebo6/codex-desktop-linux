// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：8630bb3caecaff6abc6add450a88035d9f6d3f8c

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
