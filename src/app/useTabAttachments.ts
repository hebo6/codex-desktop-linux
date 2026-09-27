import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import type { WindowTab } from "../transport/windowState";

export interface DraftAttachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly blob: Blob | null;
  readonly error: string | null;
  readonly status: "preparing" | "ready" | "error";
}

export type AttachmentDraft = readonly [
  readonly DraftAttachment[],
  Dispatch<SetStateAction<readonly DraftAttachment[]>>,
];

interface TabAttachments {
  readonly sessionId: symbol;
  readonly attachments: readonly DraftAttachment[];
}

const EMPTY_ATTACHMENTS: readonly DraftAttachment[] = Object.freeze([]);

export function useTabAttachments(
  serverId: string | null,
  tabs: readonly WindowTab[],
  activeTabId: string | null,
): { readonly draft: AttachmentDraft; readonly tabIds: ReadonlySet<string> } {
  const [state, setState] = useState(() => ({
    serverId,
    tabs,
    byTab: new Map(tabs.map((tab) => [tab.id, emptyTabAttachments()])),
  }));

  let current = state;
  if (state.serverId !== serverId || state.tabs !== tabs) {
    current = {
      serverId,
      tabs,
      byTab: new Map(tabs.map((tab) => {
        const previousTab = state.tabs.find(({ id }) => id === tab.id);
        // 新任务首次创建会话时沿用附件，已有会话被替换时开启新的草稿生命周期
        const retained = state.serverId === serverId
          && previousTab !== undefined
          && (previousTab.threadId === tab.threadId || previousTab.threadId === null);
        return [tab.id, retained ? state.byTab.get(tab.id)! : emptyTabAttachments()];
      })),
    };
    setState(current);
  }

  const active = activeTabId === null ? undefined : current.byTab.get(activeTabId);
  const sessionId = active?.sessionId;
  const setAttachments = useCallback<AttachmentDraft[1]>((update) => {
    setState((latest) => {
      if (activeTabId === null) return latest;
      const draft = latest.byTab.get(activeTabId);
      // 异步读取只能更新发起操作的草稿，关闭标签或切换服务器后不再写回
      if (draft === undefined || draft.sessionId !== sessionId) return latest;
      const attachments = typeof update === "function" ? update(draft.attachments) : update;
      if (attachments === draft.attachments) return latest;
      const byTab = new Map(latest.byTab);
      byTab.set(activeTabId, { ...draft, attachments });
      return { ...latest, byTab };
    });
  }, [activeTabId, sessionId]);

  const tabIds = useMemo(() => new Set(
    [...current.byTab].flatMap(([id, { attachments }]) => attachments.length > 0 ? [id] : []),
  ), [current.byTab]);

  return { draft: [active?.attachments ?? EMPTY_ATTACHMENTS, setAttachments], tabIds };
}

function emptyTabAttachments(): TabAttachments {
  return { sessionId: Symbol(), attachments: EMPTY_ATTACHMENTS };
}
