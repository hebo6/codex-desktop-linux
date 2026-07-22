// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export interface ConfigReadParams {
  /**
   * Optional working directory to resolve project config layers. If specified, return the effective config as seen from that directory (i.e., including any project layers between `cwd` and the project/repo root).
   */
  cwd?: string | null;
  includeLayers?: boolean;
  [k: string]: unknown | undefined;
}
