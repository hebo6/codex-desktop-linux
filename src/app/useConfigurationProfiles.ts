import { useCallback, useEffect, useRef, useState } from "react";

import type { ConfigurationSnapshot } from "../configuration";
import { configurationSnapshotReplaced } from "../store/configurationSlice";
import { useAppDispatch } from "../store/hooks";
import {
  listConfigurationProfiles,
  subscribeConfigurationProfileChanges,
  type ConfigurationProfilesChangeSubscriber,
} from "../transport/configuration";

export type ConfigurationProfilesLoadStatus =
  "idle" | "loading" | "ready" | "error";

export type ConfigurationProfilesLoader = () => Promise<ConfigurationSnapshot>;

export interface ConfigurationProfilesLoadResult {
  readonly status: ConfigurationProfilesLoadStatus;
  readonly error: string | null;
  readonly reload: () => void;
  readonly runMutation: <Result>(
    mutation: () => Promise<Result>,
  ) => Promise<Result>;
}

export const CONFIGURATION_PROFILES_LOAD_ERROR_SUMMARY =
  "无法加载服务器配置，请重试";

interface LoadState {
  readonly status: ConfigurationProfilesLoadStatus;
  readonly error: string | null;
}

const IDLE_STATE: LoadState = { status: "idle", error: null };
const LOADING_STATE: LoadState = { status: "loading", error: null };
const READY_STATE: LoadState = { status: "ready", error: null };
const ERROR_STATE: LoadState = {
  status: "error",
  error: CONFIGURATION_PROFILES_LOAD_ERROR_SUMMARY,
};

export function useConfigurationProfiles(
  loader: ConfigurationProfilesLoader = listConfigurationProfiles,
  enabled = true,
  subscribeChanges: ConfigurationProfilesChangeSubscriber = subscribeConfigurationProfileChanges,
): ConfigurationProfilesLoadResult {
  const dispatch = useAppDispatch();
  const [loadState, setLoadState] = useState<LoadState>(IDLE_STATE);
  const mountedRef = useRef(false);
  const enabledRef = useRef(enabled);
  const activeRequestRef = useRef(0);
  const mutationActiveRef = useRef(false);
  enabledRef.current = enabled;

  const startLoad = useCallback(() => {
    if (!mountedRef.current || !enabledRef.current) {
      return;
    }

    const requestId = activeRequestRef.current + 1;
    activeRequestRef.current = requestId;
    setLoadState(LOADING_STATE);

    let request: Promise<ConfigurationSnapshot>;
    try {
      request = loader();
    } catch {
      if (mountedRef.current && activeRequestRef.current === requestId) {
        setLoadState(ERROR_STATE);
      }
      return;
    }

    void request.then(
      (snapshot) => {
        if (!mountedRef.current || activeRequestRef.current !== requestId) {
          return;
        }
        dispatch(configurationSnapshotReplaced(snapshot));
        setLoadState(READY_STATE);
      },
      () => {
        if (!mountedRef.current || activeRequestRef.current !== requestId) {
          return;
        }
        setLoadState(ERROR_STATE);
      },
    );
  }, [dispatch, loader]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      activeRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    activeRequestRef.current += 1;
    if (enabled) {
      startLoad();
    } else {
      setLoadState(IDLE_STATE);
    }
  }, [enabled, startLoad]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let release: (() => void) | null = null;
    void subscribeChanges(() => {
      if (!mutationActiveRef.current) startLoad();
    }).then(
      (unsubscribe) => {
        if (disposed) unsubscribe();
        else release = unsubscribe;
      },
      () => undefined,
    );
    return () => {
      disposed = true;
      release?.();
    };
  }, [enabled, startLoad, subscribeChanges]);

  const reload = useCallback(() => {
    startLoad();
  }, [startLoad]);

  const runMutation = useCallback(
    async <Result>(mutation: () => Promise<Result>): Promise<Result> => {
      // 列表查询与修改共享同一代际。修改开始后，任何更早的完整快照都不能再
      // 覆盖修改结果；修改结束后重新读取权威快照以收敛并发窗口的变化
      activeRequestRef.current += 1;
      mutationActiveRef.current = true;
      if (mountedRef.current && enabledRef.current) {
        setLoadState(LOADING_STATE);
      }
      try {
        return await mutation();
      } finally {
        mutationActiveRef.current = false;
        startLoad();
      }
    },
    [startLoad],
  );

  return { ...loadState, reload, runMutation };
}
