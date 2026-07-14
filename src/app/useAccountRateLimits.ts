import { useCallback, useEffect, useRef, useState } from "react";

import type { AppServerAccountClient } from "../appServer";
import type { GetAccountRateLimitsResponse } from "../protocol/generated";
import { mergeRateLimitResponses, mergeRateLimitUpdate } from "./rateLimits";

export interface AccountRateLimitsState {
  readonly data: GetAccountRateLimitsResponse | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly updatedAt: number | null;
}

const EMPTY_STATE = Object.freeze({
  data: null,
  error: null,
  loading: false,
  refreshing: false,
  updatedAt: null,
}) satisfies AccountRateLimitsState;

export function useAccountRateLimits(client: AppServerAccountClient | null) {
  const [state, setState] = useState<AccountRateLimitsState>(EMPTY_STATE);
  const clientRef = useRef(client);
  const generationRef = useRef(0);
  const notificationVersionRef = useRef(0);

  const read = useCallback(async (
    target: AppServerAccountClient,
    generation: number,
    initial: boolean,
  ) => {
    const notificationVersion = notificationVersionRef.current;
    setState((current) => ({
      ...current,
      error: null,
      loading: initial && current.data === null,
      refreshing: !initial || current.data !== null,
    }));
    try {
      const response = await target.readRateLimits().result;
      if (generation !== generationRef.current || clientRef.current !== target) return;
      setState((current) => ({
        data: notificationVersionRef.current === notificationVersion && current.data === null
          ? response
          : current.data === null
            ? response
            : mergeRateLimitResponses(response, current.data),
        error: null,
        loading: false,
        refreshing: false,
        updatedAt: Date.now(),
      }));
    } catch {
      if (generation !== generationRef.current || clientRef.current !== target) return;
      setState((current) => ({
        ...current,
        error: "无法读取账户限额",
        loading: false,
        refreshing: false,
      }));
    }
  }, []);

  useEffect(() => {
    clientRef.current = client;
    const generation = ++generationRef.current;
    notificationVersionRef.current = 0;
    setState(client === null ? EMPTY_STATE : { ...EMPTY_STATE, loading: true });
    if (client === null) return;
    const release = client.subscribeRateLimitUpdates(({ params }) => {
      if (generation !== generationRef.current) return;
      notificationVersionRef.current += 1;
      setState((current) => ({
        data: mergeRateLimitUpdate(current.data, params.rateLimits),
        error: null,
        loading: false,
        refreshing: false,
        updatedAt: Date.now(),
      }));
    });
    void read(client, generation, true);
    return release;
  }, [client, read]);

  const refresh = useCallback(async () => {
    const target = clientRef.current;
    if (target === null) return;
    await read(target, generationRef.current, false);
  }, [read]);

  return { ...state, refresh };
}
