// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：a4535884169be8da2f81b8a4debecbd4dc11aa97

export type FuzzyFileSearchMatchType = "file" | "directory";

export interface FuzzyFileSearchResponse {
  files: FuzzyFileSearchResult[];
  [k: string]: unknown | undefined;
}
/**
 * Superset of [`codex_file_search::FileMatch`]
 */
export interface FuzzyFileSearchResult {
  file_name: string;
  indices?: number[] | null;
  match_type: FuzzyFileSearchMatchType;
  path: string;
  root: string;
  score: number;
  [k: string]: unknown | undefined;
}
