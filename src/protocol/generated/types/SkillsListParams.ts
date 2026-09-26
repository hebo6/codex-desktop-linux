// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：36650394c5b38c2990ccf2a3457165ca3e9d9726

export interface SkillsListParams {
  /**
   * When empty, defaults to the current session working directory.
   */
  cwds?: string[];
  /**
   * When true, bypass the skills cache and re-scan skills from disk.
   */
  forceReload?: boolean;
  [k: string]: unknown | undefined;
}
