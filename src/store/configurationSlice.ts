import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

import type {
  ConfigurationSnapshot,
  ProxyId,
  ProxyProfile,
  ServerId,
  ServerProfile,
} from "../configuration";

export interface ConfigurationState {
  readonly serversById: Readonly<Record<string, ServerProfile>>;
  readonly serverIds: readonly ServerId[];
  readonly proxiesById: Readonly<Record<string, ProxyProfile>>;
  readonly proxyIds: readonly ProxyId[];
}

export const initialConfigurationState: ConfigurationState = {
  serversById: {},
  serverIds: [],
  proxiesById: {},
  proxyIds: [],
};

const textEncoder = new TextEncoder();

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function compareAsciiNoCase(left: string, right: string): number {
  const leftBytes = textEncoder.encode(foldAsciiCase(left));
  const rightBytes = textEncoder.encode(foldAsciiCase(right));
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function compareServers(left: ServerProfile, right: ServerProfile): number {
  const leftLastUsed = left.lastUsedAtMs ?? -1;
  const rightLastUsed = right.lastUsedAtMs ?? -1;
  if (leftLastUsed !== rightLastUsed) {
    return leftLastUsed > rightLastUsed ? -1 : 1;
  }
  if (left.createdAtMs !== right.createdAtMs) {
    return left.createdAtMs > right.createdAtMs ? -1 : 1;
  }
  const nameOrder = compareAsciiNoCase(left.name, right.name);
  return nameOrder === 0
    ? compareText(left.serverId, right.serverId)
    : nameOrder;
}

function compareProxies(left: ProxyProfile, right: ProxyProfile): number {
  const nameOrder = compareAsciiNoCase(left.name, right.name);
  if (nameOrder !== 0) {
    return nameOrder;
  }
  if (left.createdAtMs !== right.createdAtMs) {
    return left.createdAtMs < right.createdAtMs ? -1 : 1;
  }
  return compareText(left.proxyId, right.proxyId);
}

function sortedServerIds(
  serversById: Readonly<Record<string, ServerProfile>>,
): ServerId[] {
  return Object.values(serversById)
    .sort(compareServers)
    .map((profile) => profile.serverId);
}

function sortedProxyIds(
  proxiesById: Readonly<Record<string, ProxyProfile>>,
): ProxyId[] {
  return Object.values(proxiesById)
    .sort(compareProxies)
    .map((profile) => profile.proxyId);
}

function synchronizeProxyReferenceCounts(
  serversById: Readonly<Record<string, ServerProfile>>,
  proxiesById: Readonly<Record<string, ProxyProfile>>,
): Readonly<Record<string, ProxyProfile>> {
  const counts = new Map<string, number>();
  for (const server of Object.values(serversById)) {
    if (
      server.configuration.type === "remoteWebSocket" &&
      server.configuration.proxyId !== undefined
    ) {
      counts.set(
        server.configuration.proxyId,
        (counts.get(server.configuration.proxyId) ?? 0) + 1,
      );
    }
  }
  return Object.fromEntries(
    Object.values(proxiesById).map((proxy) => [
      proxy.proxyId,
      {
        ...proxy,
        referencedServerCount: counts.get(proxy.proxyId) ?? 0,
      },
    ]),
  );
}

function createConfigurationState(
  serversById: Readonly<Record<string, ServerProfile>>,
  proxiesById: Readonly<Record<string, ProxyProfile>>,
): ConfigurationState {
  const synchronizedProxiesById = synchronizeProxyReferenceCounts(
    serversById,
    proxiesById,
  );
  return {
    serversById,
    serverIds: sortedServerIds(serversById),
    proxiesById: synchronizedProxiesById,
    proxyIds: sortedProxyIds(synchronizedProxiesById),
  };
}

const configurationSlice = createSlice({
  name: "configuration",
  initialState: initialConfigurationState,
  reducers: {
    configurationSnapshotReplaced(
      _state,
      action: PayloadAction<ConfigurationSnapshot>,
    ): ConfigurationState {
      const serversById = Object.fromEntries(
        action.payload.servers.map((profile) => [profile.serverId, profile]),
      );
      const proxiesById = Object.fromEntries(
        action.payload.proxies.map((profile) => [profile.proxyId, profile]),
      );
      return createConfigurationState(serversById, proxiesById);
    },
    serverProfileUpserted(
      state,
      action: PayloadAction<ServerProfile>,
    ): ConfigurationState {
      const serversById = {
        ...state.serversById,
        [action.payload.serverId]: action.payload,
      };
      return createConfigurationState(serversById, state.proxiesById);
    },
    serverProfileRemoved(
      state,
      action: PayloadAction<ServerId>,
    ): ConfigurationState {
      const serversById = Object.fromEntries(
        Object.entries(state.serversById).filter(
          ([serverId]) => serverId !== action.payload,
        ),
      );
      return createConfigurationState(serversById, state.proxiesById);
    },
    proxyProfileUpserted(
      state,
      action: PayloadAction<ProxyProfile>,
    ): ConfigurationState {
      const proxiesById = {
        ...state.proxiesById,
        [action.payload.proxyId]: action.payload,
      };
      return createConfigurationState(state.serversById, proxiesById);
    },
    proxyProfileRemoved(
      state,
      action: PayloadAction<ProxyId>,
    ): ConfigurationState {
      const proxiesById = Object.fromEntries(
        Object.entries(state.proxiesById).filter(
          ([proxyId]) => proxyId !== action.payload,
        ),
      );
      return createConfigurationState(state.serversById, proxiesById);
    },
  },
});

export const {
  configurationSnapshotReplaced,
  serverProfileUpserted,
  serverProfileRemoved,
  proxyProfileUpserted,
  proxyProfileRemoved,
} = configurationSlice.actions;
export const configurationReducer = configurationSlice.reducer;

export interface ConfigurationRootState {
  readonly configuration: ConfigurationState;
}

export const selectConfigurationState = (state: ConfigurationRootState) =>
  state.configuration;

export const selectServerIds = (
  state: ConfigurationRootState,
): readonly ServerId[] =>
  state.configuration.serverIds;

export const selectServerProfiles = (
  state: ConfigurationRootState,
): readonly ServerProfile[] =>
  state.configuration.serverIds.flatMap((serverId) => {
    const profile = state.configuration.serversById[serverId];
    return profile === undefined ? [] : [profile];
  });

export const selectServerProfileById = (
  state: ConfigurationRootState,
  serverId: ServerId,
): ServerProfile | undefined => state.configuration.serversById[serverId];

export const selectProxyIds = (
  state: ConfigurationRootState,
): readonly ProxyId[] =>
  state.configuration.proxyIds;

export const selectProxyProfiles = (
  state: ConfigurationRootState,
): readonly ProxyProfile[] =>
  state.configuration.proxyIds.flatMap((proxyId) => {
    const profile = state.configuration.proxiesById[proxyId];
    return profile === undefined ? [] : [profile];
  });

export const selectProxyProfileById = (
  state: ConfigurationRootState,
  proxyId: ProxyId,
): ProxyProfile | undefined => state.configuration.proxiesById[proxyId];
