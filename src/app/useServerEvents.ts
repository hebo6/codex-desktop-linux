import { useMemo, useSyncExternalStore } from "react";

import type { ServerEventStore } from "../appServer/serverEventState";

/** Keep receipt synchronous in the store while coalescing streaming UI updates. */
export function useServerEvents(store: ServerEventStore | null) {
  const source = useMemo(() => ({
    read: () => store?.getSnapshot() ?? null,
    subscribe: (notify: () => void) => {
      if (store === null) return () => undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const release = store.subscribe(() => {
        if (timer !== undefined) return;
        timer = setTimeout(() => {
          timer = undefined;
          notify();
        }, 80);
      });
      return () => {
        release();
        clearTimeout(timer);
      };
    },
  }), [store]);

  return useSyncExternalStore(source.subscribe, source.read, source.read);
}
