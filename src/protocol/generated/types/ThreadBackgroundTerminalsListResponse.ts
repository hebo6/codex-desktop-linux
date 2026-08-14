// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：8630bb3caecaff6abc6add450a88035d9f6d3f8c

export type LegacyAppPathString = string;

export interface ThreadBackgroundTerminalsListResponse {
  data: ThreadBackgroundTerminal[];
  /**
   * Opaque cursor to pass to the next call to continue after the last item. If None, there are no more items to return.
   */
  nextCursor?: string | null;
  [k: string]: unknown | undefined;
}
export interface ThreadBackgroundTerminal {
  command: string;
  cpuPercent?: number | null;
  cwd: LegacyAppPathString;
  itemId: string;
  osPid?: number | null;
  processId: string;
  rssKb?: number | null;
  [k: string]: unknown | undefined;
}
