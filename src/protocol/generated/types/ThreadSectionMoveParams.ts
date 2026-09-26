// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex CLI 版本：codex-cli 0.157.1

/**
 * Parameters for moving a thread within a server-owned section ordering.
 */
export interface ThreadSectionMoveParams {
  /**
   * Existing thread to insert before; omission or null appends to the section.
   */
  beforeThreadId?: string | null;
  /**
   * Destination section, or `null` to remove the thread from its section.
   */
  sectionId: string | null;
  /**
   * Thread to move into, within, or out of a section.
   */
  threadId: string;
  [k: string]: unknown | undefined;
}
