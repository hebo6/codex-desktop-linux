import { useSyncExternalStore } from "react";

import type { AppServerInteractionClient, InteractionSnapshot } from "../appServer";

const EMPTY_SNAPSHOT = Object.freeze({
  pending: Object.freeze([]),
  resolvedElsewhereCount: 0,
}) satisfies InteractionSnapshot;

export function useServerInteractions(client: AppServerInteractionClient | null) {
  const snapshot = useSyncExternalStore(
    client?.subscribe ?? emptySubscribe,
    client?.getSnapshot ?? emptySnapshot,
    client?.getSnapshot ?? emptySnapshot,
  );
  return {
    ...snapshot,
    respond: (key: string, response: unknown) => client?.respond(key, response) ?? false,
  };
}

function emptySubscribe(): () => void { return () => undefined; }
function emptySnapshot(): InteractionSnapshot { return EMPTY_SNAPSHOT; }
