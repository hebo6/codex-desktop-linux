import { useCallback, useEffect, useRef, useState } from "react";

import type { AppServerAccountClient } from "../appServer";
import type { GetAccountRateLimitsResponse } from "../protocol/generated";
import { mergeRateLimitResponses, mergeRateLimitUpdate } from "./rateLimits";

export interface AccountRateLimitsState {
  readonly data: GetAccountRateLimitsResponse | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly resetting: boolean;
  readonly updatedAt: number | null;
}

const EMPTY_STATE = Object.freeze({
  data: null,
  error: null,
  loading: false,
  refreshing: false,
  resetting: false,
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
      resetting: false,
    }));
    try {
      const response = await target.readRateLimits().result;
      if (generation !== generationRef.current || clientRef.current !== target) return;
      setState((current) => ({
        data: notificationVersionRef.current === notificationVersion
          ? response
          : current.data === null
            ? response
            : mergeRateLimitResponses(response, current.data),
        error: null,
        loading: false,
        refreshing: false,
        resetting: false,
        updatedAt: Date.now(),
      }));
    } catch {
      if (generation !== generationRef.current || clientRef.current !== target) return;
      setState((current) => ({
        ...current,
        error: "无法读取账户限额",
        loading: false,
        refreshing: false,
        resetting: false,
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
        resetting: false,
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

  const consumeResetCredit = useCallback(async (creditId?: string | null) => {
    const target = clientRef.current;
    if (target === null) return;
    setState((current) => ({
      ...current,
      error: null,
      resetting: true,
    }));
    try {
      const response = await target.consumeRateLimitResetCredit({
        idempotencyKey: crypto.randomUUID(),
        ...(creditId !== undefined ? { creditId } : {}),
      }).result;
      if (clientRef.current !== target) return;
      if (response.outcome === "reset" || response.outcome === "alreadyRedeemed") {
        await read(target, generationRef.current, false);
      } else {
        const errorMsg =
          response.outcome === "nothingToReset"
            ? "当前没有可重置的限额窗口"
            : response.outcome === "noCredit"
              ? "无可用的重置次数"
              : "重置限额未成功";
        setState((current) => ({
          ...current,
          error: errorMsg,
          resetting: false,
        }));
      }
    } catch {
      if (clientRef.current !== target) return;
      setState((current) => ({
        ...current,
        error: "重置限额失败，请稍后重试",
        resetting: false,
      }));
    }
  }, [read]);

  return { ...state, refresh, consumeResetCredit };
}
