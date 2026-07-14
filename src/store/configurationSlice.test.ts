import { describe, expect, it } from "vitest";

import type {
  ProxyId,
  ProxyProfile,
  ServerId,
  ServerProfile,
} from "../configuration";
import {
  configurationReducer,
  configurationSnapshotReplaced,
  initialConfigurationState,
  proxyProfileRemoved,
  proxyProfileUpserted,
  selectProxyProfileById,
  selectProxyProfiles,
  selectServerProfileById,
  selectServerProfiles,
  serverProfileRemoved,
  serverProfileUpserted,
} from "./configurationSlice";

const SERVER_A = "11111111-1111-4111-8111-111111111111" as ServerId;
const SERVER_B = "22222222-2222-4222-8222-222222222222" as ServerId;
const SERVER_C = "33333333-3333-4333-8333-333333333333" as ServerId;
const PROXY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as ProxyId;
const PROXY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as ProxyId;

function serverProfile(
  serverId: ServerId,
  name: string,
  lastUsedAtMs?: number,
  version = 1,
  createdAtMs = 1_000,
): ServerProfile {
  return {
    serverId,
    name,
    version,
    configuration: {
      type: "localStdio",
      executablePath: "/usr/bin/codex",
      arguments: ["app-server"],
      nonSensitiveEnvironment: {},
    },
    credentialConfigured: false,
    activeWindowCount: 0,
    createdAtMs,
    updatedAtMs: createdAtMs + 1_000,
    ...(lastUsedAtMs === undefined ? {} : { lastUsedAtMs }),
  };
}

function remoteServerProfile(
  serverId: ServerId,
  name: string,
  proxyId?: ProxyId,
): ServerProfile {
  return {
    serverId,
    name,
    version: 1,
    configuration: {
      type: "remoteWebSocket",
      url: "wss://codex.example.test/app",
      authentication: "none",
      nonSensitiveHeaders: {},
      connectTimeoutMs: 5_000,
      tlsCertificatePolicy: "strict",
      plaintextConfirmed: false,
      ...(proxyId === undefined ? {} : { proxyId }),
    },
    credentialConfigured: false,
    activeWindowCount: 0,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
  };
}

function proxyProfile(
  proxyId: ProxyId,
  name: string,
  version = 1,
): ProxyProfile {
  return {
    proxyId,
    name,
    version,
    configuration: {
      type: "httpConnect",
      url: "https://proxy.example.test:8443",
      authentication: "none",
      nonSensitiveHeaders: {},
      connectTimeoutMs: 5_000,
      tlsCertificatePolicy: "strict",
    },
    credentialConfigured: false,
    referencedServerCount: 0,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
  };
}

describe("configurationReducer", () => {
  it("默认使用空的规范化实体映射", () => {
    expect(configurationReducer(undefined, { type: "unknown" })).toEqual(
      initialConfigurationState,
    );
  });

  it("替换快照并按最近使用、名称和稳定 ID 排序", () => {
    const state = configurationReducer(
      undefined,
      configurationSnapshotReplaced({
        servers: [
          serverProfile(SERVER_C, "Zulu"),
          serverProfile(SERVER_B, "Alpha", 5_000),
          serverProfile(SERVER_A, "Alpha", 5_000),
        ],
        proxies: [
          proxyProfile(PROXY_B, "Proxy"),
          proxyProfile(PROXY_A, "Proxy"),
        ],
      }),
    );

    expect(state.serverIds).toEqual([SERVER_A, SERVER_B, SERVER_C]);
    expect(state.proxyIds).toEqual([PROXY_A, PROXY_B]);
    expect(Object.keys(state.serversById).sort()).toEqual(
      [SERVER_A, SERVER_B, SERVER_C].sort(),
    );
    expect(Object.keys(state.proxiesById).sort()).toEqual(
      [PROXY_A, PROXY_B].sort(),
    );
    expect(selectServerProfiles({ configuration: state }).map(({ serverId }) => serverId)).toEqual(
      [SERVER_A, SERVER_B, SERVER_C],
    );
    expect(selectProxyProfiles({ configuration: state }).map(({ proxyId }) => proxyId)).toEqual(
      [PROXY_A, PROXY_B],
    );
  });

  it("再次替换快照会移除旧实体", () => {
    const populated = configurationReducer(
      undefined,
      configurationSnapshotReplaced({
        servers: [serverProfile(SERVER_A, "Old")],
        proxies: [proxyProfile(PROXY_A, "Old")],
      }),
    );
    const replaced = configurationReducer(
      populated,
      configurationSnapshotReplaced({
        servers: [serverProfile(SERVER_B, "New")],
        proxies: [proxyProfile(PROXY_B, "New")],
      }),
    );

    expect(replaced.serverIds).toEqual([SERVER_B]);
    expect(replaced.serversById[SERVER_A]).toBeUndefined();
    expect(replaced.proxyIds).toEqual([PROXY_B]);
    expect(replaced.proxiesById[PROXY_A]).toBeUndefined();
  });

  it("无最近使用时间时按较新的创建时间优先排序", () => {
    const state = configurationReducer(
      undefined,
      configurationSnapshotReplaced({
        servers: [
          serverProfile(SERVER_A, "Zulu", undefined, 1, 3_000),
          serverProfile(SERVER_B, "Alpha", undefined, 1, 4_000),
        ],
        proxies: [],
      }),
    );

    expect(state.serverIds).toEqual([SERVER_B, SERVER_A]);
  });

  it("名称排序与 SQLite NOCASE 的 UTF-8 字节顺序一致", () => {
    const state = configurationReducer(
      undefined,
      configurationSnapshotReplaced({
        servers: [],
        proxies: [
          proxyProfile(PROXY_A, "\u{10000}"),
          proxyProfile(PROXY_B, "\u{e000}"),
        ],
      }),
    );

    expect(state.proxyIds).toEqual([PROXY_B, PROXY_A]);
  });

  it("upsert 更新实体并重排，remove 同步移除 ID 与实体", () => {
    let state = configurationReducer(
      undefined,
      configurationSnapshotReplaced({
        servers: [
          serverProfile(SERVER_A, "Alpha", 1_000),
          serverProfile(SERVER_B, "Beta", 2_000),
        ],
        proxies: [proxyProfile(PROXY_A, "Zulu")],
      }),
    );

    state = configurationReducer(
      state,
      serverProfileUpserted(serverProfile(SERVER_A, "Alpha", 3_000, 2)),
    );
    state = configurationReducer(
      state,
      proxyProfileUpserted(proxyProfile(PROXY_B, "Alpha")),
    );
    expect(state.serverIds).toEqual([SERVER_A, SERVER_B]);
    expect(state.serversById[SERVER_A]?.version).toBe(2);
    expect(state.proxyIds).toEqual([PROXY_B, PROXY_A]);

    state = configurationReducer(state, serverProfileRemoved(SERVER_A));
    state = configurationReducer(state, proxyProfileRemoved(PROXY_A));
    expect(state.serverIds).toEqual([SERVER_B]);
    expect(state.serversById[SERVER_A]).toBeUndefined();
    expect(state.proxyIds).toEqual([PROXY_B]);
    expect(state.proxiesById[PROXY_A]).toBeUndefined();
  });

  it("按 ID selector 返回同一规范化实体", () => {
    const server = serverProfile(SERVER_A, "Local");
    const proxy = proxyProfile(PROXY_A, "HTTP");
    const state = configurationReducer(
      undefined,
      configurationSnapshotReplaced({ servers: [server], proxies: [proxy] }),
    );
    const rootState = { configuration: state };

    expect(selectServerProfileById(rootState, SERVER_A)).toEqual(server);
    expect(selectProxyProfileById(rootState, PROXY_A)).toEqual(proxy);
    expect(selectServerProfileById(rootState, SERVER_B)).toBeUndefined();
    expect(selectProxyProfileById(rootState, PROXY_B)).toBeUndefined();
  });

  it("服务器变更后重算全部代理引用计数", () => {
    let state = configurationReducer(
      undefined,
      configurationSnapshotReplaced({
        servers: [],
        proxies: [proxyProfile(PROXY_A, "A"), proxyProfile(PROXY_B, "B")],
      }),
    );

    state = configurationReducer(
      state,
      serverProfileUpserted(remoteServerProfile(SERVER_A, "Remote", PROXY_A)),
    );
    expect(state.proxiesById[PROXY_A]?.referencedServerCount).toBe(1);
    expect(state.proxiesById[PROXY_B]?.referencedServerCount).toBe(0);

    state = configurationReducer(
      state,
      serverProfileUpserted(remoteServerProfile(SERVER_A, "Remote", PROXY_B)),
    );
    expect(state.proxiesById[PROXY_A]?.referencedServerCount).toBe(0);
    expect(state.proxiesById[PROXY_B]?.referencedServerCount).toBe(1);

    state = configurationReducer(
      state,
      serverProfileUpserted(remoteServerProfile(SERVER_A, "Direct")),
    );
    expect(state.proxiesById[PROXY_B]?.referencedServerCount).toBe(0);

    state = configurationReducer(
      state,
      serverProfileUpserted(remoteServerProfile(SERVER_A, "Remote", PROXY_A)),
    );
    state = configurationReducer(state, serverProfileRemoved(SERVER_A));
    expect(state.proxiesById[PROXY_A]?.referencedServerCount).toBe(0);
  });
});
