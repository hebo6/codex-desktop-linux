// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

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
