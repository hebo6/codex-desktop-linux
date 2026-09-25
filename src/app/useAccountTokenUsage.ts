import { useCallback, useEffect, useRef, useState } from "react";

import type { AppServerAccountClient } from "../appServer";
import type { GetAccountTokenUsageResponse } from "../protocol/generated";

export interface AccountTokenUsageState {
  readonly data: GetAccountTokenUsageResponse | null;
  readonly error: string | null;
  readonly loading: boolean;
}

const EMPTY_STATE = Object.freeze({
  data: null,
  error: null,
  loading: false,
}) satisfies AccountTokenUsageState;

export function useAccountTokenUsage(client: AppServerAccountClient | null) {
  const [state, setState] = useState<AccountTokenUsageState>(EMPTY_STATE);
  const clientRef = useRef(client);
  const generationRef = useRef(0);
  const requestVersionRef = useRef(0);

  const read = useCallback(async (target: AppServerAccountClient, generation: number) => {
    const requestVersion = ++requestVersionRef.current;
    setState((current) => ({
      ...current,
      error: null,
      loading: current.data === null,
    }));
    try {
      const response = await target.readTokenUsage().result;
      if (generation !== generationRef.current || clientRef.current !== target || requestVersion !== requestVersionRef.current) return;
      setState({
        data: response,
        error: null,
        loading: false,
      });
    } catch {
      if (generation !== generationRef.current || clientRef.current !== target || requestVersion !== requestVersionRef.current) return;
      setState((current) => ({
        ...current,
        error: "无法读取账户Token用量历史",
        loading: false,
      }));
    }
  }, []);

  useEffect(() => {
    clientRef.current = client;
    const generation = ++generationRef.current;
    setState(client === null ? EMPTY_STATE : { ...EMPTY_STATE, loading: true });
    if (client === null) return;
    const release = client.subscribeAccountUpdates(() => {
      setState({ ...EMPTY_STATE, loading: true });
      void read(client, generation);
    });
    void read(client, generation);
    return release;
  }, [client, read]);

  return { ...state };
}
