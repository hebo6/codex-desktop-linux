import { useCallback, useEffect, useRef, useState } from "react";

import type { AppServerAccountClient } from "../appServer";
import type { GetAccountResponse } from "../protocol/generated";

export function useAccountIdentity(client: AppServerAccountClient | null) {
  const [email, setEmail] = useState<string | null>(null);
  const clientRef = useRef(client);
  const generationRef = useRef(0);
  const requestVersionRef = useRef(0);

  const read = useCallback(async (
    target: AppServerAccountClient,
    generation: number,
  ) => {
    const requestVersion = ++requestVersionRef.current;
    try {
      const response = await target.readAccount().result;
      if (
        generation !== generationRef.current
        || clientRef.current !== target
        || requestVersion !== requestVersionRef.current
      ) return;
      setEmail(accountEmail(response));
    } catch {
      if (
        generation !== generationRef.current
        || clientRef.current !== target
        || requestVersion !== requestVersionRef.current
      ) return;
      setEmail(null);
    }
  }, []);

  useEffect(() => {
    clientRef.current = client;
    const generation = ++generationRef.current;
    requestVersionRef.current = 0;
    setEmail(null);
    if (client === null) return;
    const release = client.subscribeAccountUpdates(() => {
      if (generation !== generationRef.current) return;
      void read(client, generation);
    });
    void read(client, generation);
    return release;
  }, [client, read]);

  const refresh = useCallback(async () => {
    const target = clientRef.current;
    if (target === null) return;
    await read(target, generationRef.current);
  }, [read]);

  return { email, refresh };
}

function accountEmail(response: GetAccountResponse): string | null {
  if (response.account?.type !== "chatgpt") return null;
  return response.account.email?.trim() || null;
}
