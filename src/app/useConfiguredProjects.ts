import { useCallback, useEffect, useState } from "react";

import type { CapabilityClient } from "../appServer";
import type { ConfigReadResponse } from "../protocol/generated";

export interface ConfiguredProjectsState {
  readonly directories: readonly string[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly remove: (directory: string) => Promise<void>;
}

type ConfiguredProjectsSnapshot = Omit<ConfiguredProjectsState, "remove">;

const EMPTY_DIRECTORIES = Object.freeze([]) as readonly string[];
const IDLE_STATE = Object.freeze({
  directories: EMPTY_DIRECTORIES,
  loading: false,
  error: null,
}) satisfies ConfiguredProjectsSnapshot;

export function useConfiguredProjects(
  client: CapabilityClient | null,
  refreshKey: string | null = null,
): ConfiguredProjectsState {
  const [state, setState] = useState<ConfiguredProjectsSnapshot>(IDLE_STATE);

  useEffect(() => {
    let disposed = false;
    if (client === null) {
      setState(IDLE_STATE);
      return;
    }

    setState({
      directories: EMPTY_DIRECTORIES,
      loading: true,
      error: null,
    });
    void client.readConfig({ includeLayers: false }).result.then(
      ({ config }) => {
        if (disposed) {
          return;
        }
        try {
          setState({
            directories: configuredProjectDirectories(config),
            loading: false,
            error: null,
          });
        } catch {
          setState({
            directories: EMPTY_DIRECTORIES,
            loading: false,
            error: "服务器返回的项目配置无效",
          });
        }
      },
      () => {
        if (!disposed) {
          setState({
            directories: EMPTY_DIRECTORIES,
            loading: false,
            error: "无法读取服务器项目配置",
          });
        }
      },
    );

    return () => {
      disposed = true;
    };
  }, [client, refreshKey]);

  const remove = useCallback(async (directory: string) => {
    if (client === null) {
      throw new TypeError("cannot remove a project without an app-server client");
    }
    await client.writeConfigValue({
      keyPath: `projects.${JSON.stringify(directory)}`,
      value: null,
      mergeStrategy: "replace",
    }).result;
    setState((current) => ({
      ...current,
      directories: Object.freeze(
        current.directories.filter((candidate) => candidate !== directory),
      ),
    }));
  }, [client]);

  return { ...state, remove };
}

export function configuredProjectDirectories(
  config: ConfigReadResponse["config"],
): readonly string[] {
  const projects = config.projects;
  if (projects === undefined || projects === null) {
    return EMPTY_DIRECTORIES;
  }
  if (!isRecord(projects)) {
    throw new TypeError("config.projects must be an object");
  }

  const directories = Object.entries(projects).flatMap(([directory, project]) =>
    directory.length > 0 && isRecord(project) ? [directory] : [],
  );
  directories.sort(compareDirectories);
  return Object.freeze(directories);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareDirectories(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
