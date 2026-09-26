// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：36650394c5b38c2990ccf2a3457165ca3e9d9726

export interface ConfigReadParams {
  /**
   * Optional working directory to resolve project config layers. If specified, return the effective config as seen from that directory (i.e., including any project layers between `cwd` and the project/repo root).
   */
  cwd?: string | null;
  includeLayers?: boolean;
  [k: string]: unknown | undefined;
}
