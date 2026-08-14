// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：8630bb3caecaff6abc6add450a88035d9f6d3f8c

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
