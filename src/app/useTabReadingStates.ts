import { useState } from "react";

import type { ConversationReadingStateStore } from "../components/ConversationView";

interface ReadingTab {
  readonly id: string;
  readonly threadId: string | null;
}

export function useTabReadingStates(
  serverId: string | null,
  tabs: readonly ReadingTab[],
): ReadonlyMap<string, ConversationReadingStateStore> {
  const [state, setState] = useState(() => ({
    serverId,
    tabs,
    byTab: new Map<string, ConversationReadingStateStore>(
      tabs.filter(({ threadId }) => threadId !== null)
        .map(({ id }) => [id, { current: null }]),
    ),
  }));

  let current = state;
  if (state.serverId !== serverId || state.tabs !== tabs) {
    current = {
      serverId,
      tabs,
      byTab: new Map(tabs.filter(({ threadId }) => threadId !== null).map((tab) => {
        const previousTab = state.tabs.find(({ id }) => id === tab.id);
        const retained = state.serverId === serverId
          && previousTab?.threadId === tab.threadId;
        return [tab.id, retained ? state.byTab.get(tab.id)! : { current: null }];
      })),
    };
    setState(current);
  }

  return current.byTab;
}
