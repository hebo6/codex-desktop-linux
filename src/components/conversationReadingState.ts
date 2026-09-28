import type { ThreadTurn } from "../app/useServerThreads";

interface ReadingAnchor {
  readonly turnId: string;
  readonly itemId: string;
  readonly offset: number;
}

export interface ConversationReadingState {
  readonly anchor: ReadingAnchor | null;
  readonly following: boolean;
  readonly runningTurnId: string | null;
  readonly latestTurn: ThreadTurn | null;
  readonly hasUnreadContent: boolean;
}

export interface ConversationReadingStateStore {
  current: ConversationReadingState | null;
}

export function captureReadingAnchor(scroller: HTMLElement): ReadingAnchor | null {
  const viewportTop = scroller.getBoundingClientRect().top;
  const rows = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-reading-item-id]"),
  );
  const row = rows.find((element) => element.getBoundingClientRect().bottom > viewportTop)
    ?? rows.at(-1);
  if (row === undefined) return null;
  return {
    turnId: row.dataset.turnId!,
    itemId: row.dataset.readingItemId!,
    offset: row.getBoundingClientRect().top - viewportTop,
  };
}

export function restoreReadingAnchor(
  scroller: HTMLElement,
  anchor: ReadingAnchor | null,
): boolean {
  if (anchor === null) return false;
  const row = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-reading-item-id]"),
  ).find((element) =>
    element.dataset.turnId === anchor.turnId &&
    element.dataset.readingItemId === anchor.itemId
  );
  if (row === undefined) return false;
  const rect = row.getBoundingClientRect();
  // 活动组重新挂载时恢复默认折叠态；原阅读位置已收起时显示组标题
  const offset = anchor.offset <= -rect.height ? 0 : anchor.offset;
  scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top - offset;
  return true;
}

export function hasNewConversationContent(
  previous: ThreadTurn | null,
  latest: ThreadTurn | null,
): boolean {
  if (previous === latest) return false;
  return previous?.id !== latest?.id || previous?.status !== latest?.status ||
    JSON.stringify(previous?.items) !== JSON.stringify(latest?.items);
}
