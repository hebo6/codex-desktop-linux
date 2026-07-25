// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：a4535884169be8da2f81b8a4debecbd4dc11aa97

export interface ConfigReadParams {
  /**
   * Optional working directory to resolve project config layers. If specified, return the effective config as seen from that directory (i.e., including any project layers between `cwd` and the project/repo root).
   */
  cwd?: string | null;
  includeLayers?: boolean;
  [k: string]: unknown | undefined;
}
