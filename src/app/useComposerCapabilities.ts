import { useCallback, useEffect, useRef, useState } from "react";

import type { CapabilityClient } from "../appServer";
import type { AppInfo } from "../protocol/generated/types/AppsListResponse";
import type { FuzzyFileSearchResult } from "../protocol/generated/types/FuzzyFileSearchResponse";
import type { Model } from "../protocol/generated/types/ModelListResponse";
import type { PermissionProfileSummary } from "../protocol/generated/types/PermissionProfileListResponse";
import type { PluginListResponse } from "../protocol/generated/types/PluginListResponse";
import type { SkillMetadata } from "../protocol/generated/types/SkillsListResponse";

export interface ComposerMentionReference {
  readonly kind: "app" | "plugin";
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly path: string;
  readonly searchTerms: readonly string[];
}

export interface ComposerCapabilities {
  readonly models: readonly Model[];
  readonly modelsLoading: boolean;
  readonly defaultPermission: string | null;
  readonly permissions: readonly PermissionProfileSummary[];
  readonly permissionsLoading: boolean;
  readonly mentionReferences: readonly ComposerMentionReference[];
  readonly mentionsLoading: boolean;
  readonly mentionsError: string | null;
  readonly skills: readonly SkillMetadata[];
  readonly skillsLoading: boolean;
  readonly skillsLoaded: boolean;
  readonly error: string | null;
  readonly loadSkills: (forceReload?: boolean) => Promise<void>;
  readonly loadMentions: (forceReload?: boolean) => Promise<void>;
  readonly searchFiles: (query: string) => Promise<readonly FuzzyFileSearchResult[]>;
  readonly reload: () => void;
}

export function useComposerCapabilities(
  client: CapabilityClient | null,
  cwd: string | null,
): ComposerCapabilities {
  const [models, setModels] = useState<readonly Model[]>([]);
  const [permissions, setPermissions] = useState<readonly PermissionProfileSummary[]>([]);
  const [defaultPermission, setDefaultPermission] = useState<string | null>(null);
  const [skills, setSkills] = useState<readonly SkillMetadata[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [mentionReferences, setMentionReferences] = useState<readonly ComposerMentionReference[]>([]);
  const [mentionsLoading, setMentionsLoading] = useState(false);
  const [mentionsLoaded, setMentionsLoaded] = useState(false);
  const [mentionsError, setMentionsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const clientRef = useRef(client);
  const skillsRequestRef = useRef(0);
  const mentionsRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  clientRef.current = client;

  useEffect(() => {
    let disposed = false;
    setModels([]);
    setPermissions([]);
    setDefaultPermission(null);
    setSkills([]);
    setSkillsLoaded(false);
    setMentionReferences([]);
    setMentionsLoading(false);
    setMentionsLoaded(false);
    setMentionsError(null);
    setError(null);
    if (client === null) {
      setModelsLoading(false);
      setPermissionsLoading(false);
      return;
    }

    setModelsLoading(true);
    void readAllModels(client).then(
      (data) => {
        if (!disposed) {
          setModels(data);
          setModelsLoading(false);
        }
      },
      () => {
        if (!disposed) {
          setModelsLoading(false);
          setError("无法读取服务器模型列表");
        }
      },
    );

    setPermissionsLoading(true);
    void readPermissionCapabilities(client, cwd).then(
      ({ defaultPermission: nextDefaultPermission, permissions: data }) => {
        if (!disposed) {
          setPermissions(data);
          setDefaultPermission(nextDefaultPermission);
          setPermissionsLoading(false);
        }
      },
      () => {
        if (!disposed) {
          setPermissionsLoading(false);
          setError("无法读取服务器权限配置");
        }
      },
    );

    return () => {
      disposed = true;
      skillsRequestRef.current += 1;
      mentionsRequestRef.current += 1;
      searchRequestRef.current += 1;
    };
  }, [client, cwd, reloadGeneration]);

  const loadMentions = useCallback(async (forceReload = false): Promise<void> => {
    const activeClient = clientRef.current;
    if (activeClient === null || (mentionsLoaded && !forceReload)) {
      return;
    }
    const request = ++mentionsRequestRef.current;
    setMentionsLoading(true);
    setMentionsError(null);
    const [appsResult, pluginsResult] = await Promise.allSettled([
      readAllApps(activeClient),
      readPluginReferences(activeClient, cwd),
    ]);
    if (request !== mentionsRequestRef.current || activeClient !== clientRef.current) {
      return;
    }
    const references = [
      ...(appsResult.status === "fulfilled" ? appReferences(appsResult.value) : []),
      ...(pluginsResult.status === "fulfilled" ? pluginsResult.value : []),
    ];
    setMentionReferences(references);
    setMentionsLoaded(appsResult.status === "fulfilled" && pluginsResult.status === "fulfilled");
    if (appsResult.status === "rejected" || pluginsResult.status === "rejected") {
      setMentionsError("部分应用或插件引用无法读取，重新打开菜单可重试");
    }
    setMentionsLoading(false);
  }, [cwd, mentionsLoaded]);

  const loadSkills = useCallback(async (forceReload = false): Promise<void> => {
    const activeClient = clientRef.current;
    if (activeClient === null || (skillsLoaded && !forceReload)) {
      return;
    }
    const request = ++skillsRequestRef.current;
    setSkillsLoading(true);
    setError(null);
    try {
      const response = await activeClient.listSkills({
        ...(cwd === null ? {} : { cwds: [cwd] }),
        forceReload,
      }).result;
      if (request !== skillsRequestRef.current || activeClient !== clientRef.current) {
        return;
      }
      setSkills(response.data.flatMap(({ skills: values }) => values));
      setSkillsLoaded(true);
    } catch {
      if (request === skillsRequestRef.current && activeClient === clientRef.current) {
        setError("无法读取技能列表，普通文本仍可发送");
      }
    } finally {
      if (request === skillsRequestRef.current && activeClient === clientRef.current) {
        setSkillsLoading(false);
      }
    }
  }, [cwd, skillsLoaded]);

  const searchFiles = useCallback(async (
    query: string,
  ): Promise<readonly FuzzyFileSearchResult[]> => {
    const activeClient = clientRef.current;
    if (activeClient === null || cwd === null) {
      return [];
    }
    const request = ++searchRequestRef.current;
    const response = await activeClient.searchFiles({
      cancellationToken: `desktop-${request}-${crypto.randomUUID()}`,
      query,
      roots: [cwd],
    }).result;
    if (request !== searchRequestRef.current || activeClient !== clientRef.current) {
      return [];
    }
    return response.files;
  }, [cwd]);

  return {
    models,
    modelsLoading,
    defaultPermission,
    permissions,
    permissionsLoading,
    mentionReferences,
    mentionsLoading,
    mentionsError,
    skills,
    skillsLoading,
    skillsLoaded,
    error,
    loadSkills,
    loadMentions,
    searchFiles,
    reload: () => setReloadGeneration((value) => value + 1),
  };
}

async function readAllApps(client: CapabilityClient): Promise<readonly AppInfo[]> {
  const data: AppInfo[] = [];
  let cursor: string | null | undefined;
  do {
    const response = await client.listApps({
      ...(cursor === undefined ? {} : { cursor }),
      limit: 100,
    }).result;
    data.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor !== null && cursor !== undefined);
  return data;
}

function appReferences(apps: readonly AppInfo[]): readonly ComposerMentionReference[] {
  return apps.flatMap((app) => {
    if (app.isAccessible !== true || app.isEnabled === false) return [];
    const description = app.description?.trim() || "服务器应用连接器";
    return [{
      kind: "app" as const,
      name: app.name,
      description,
      source: app.pluginDisplayNames?.join("、") || "应用",
      path: `app://${app.id}`,
      searchTerms: [app.id, app.name, description, ...(app.pluginDisplayNames ?? [])],
    }];
  });
}

async function readPluginReferences(
  client: CapabilityClient,
  cwd: string | null,
): Promise<readonly ComposerMentionReference[]> {
  const response: PluginListResponse = await client.listPlugins({
    ...(cwd === null ? {} : { cwds: [cwd] }),
  }).result;
  return response.marketplaces.flatMap((marketplace) => marketplace.plugins.flatMap((plugin) => {
    if (!plugin.installed || !plugin.enabled || plugin.availability === "DISABLED_BY_ADMIN") return [];
    const displayName = plugin.interface?.displayName?.trim() || plugin.name;
    const description = plugin.interface?.shortDescription?.trim() || marketplace.name;
    return [{
      kind: "plugin" as const,
      name: displayName,
      description,
      source: marketplace.interface?.displayName?.trim() || marketplace.name || "插件",
      path: `plugin://${plugin.id}`,
      searchTerms: [plugin.id, plugin.name, displayName, description, marketplace.name, ...(plugin.keywords ?? [])],
    }];
  }));
}

async function readAllModels(client: CapabilityClient): Promise<readonly Model[]> {
  const data: Model[] = [];
  let cursor: string | null | undefined;
  do {
    const response = await client.listModels({
      ...(cursor === undefined ? {} : { cursor }),
      includeHidden: false,
      limit: 100,
    }).result;
    data.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor !== null && cursor !== undefined);
  return data;
}

async function readAllPermissions(
  client: CapabilityClient,
  cwd: string | null,
): Promise<readonly PermissionProfileSummary[]> {
  const data: PermissionProfileSummary[] = [];
  let cursor: string | null | undefined;
  do {
    const response = await client.listPermissionProfiles({
      ...(cursor === undefined ? {} : { cursor }),
      cwd,
      limit: 100,
    }).result;
    data.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor !== null && cursor !== undefined);
  return data;
}

async function readPermissionCapabilities(
  client: CapabilityClient,
  cwd: string | null,
): Promise<{
  readonly defaultPermission: string | null;
  readonly permissions: readonly PermissionProfileSummary[];
}> {
  const [permissionsResult, configResult, requirementsResult] = await Promise.allSettled([
    readAllPermissions(client, cwd),
    client.readConfig({ cwd, includeLayers: false }).result,
    client.readConfigRequirements().result,
  ]);
  if (permissionsResult.status === "rejected") {
    throw permissionsResult.reason;
  }

  const configuredDefault = configResult.status === "fulfilled"
    ? nonEmptyString(configResult.value.config.default_permissions)
    : null;
  const requirements = requirementsResult.status === "fulfilled"
    ? requirementsResult.value.requirements
    : null;
  const managedDefault = nonEmptyString(requirements?.defaultPermissions);
  const allowed = requirements?.allowedPermissionProfiles;
  const configuredAllowed = configuredDefault !== null && (
    allowed === null || allowed === undefined || allowed[configuredDefault] === true
  );
  const managedAllowed = managedDefault !== null && (
    allowed === null || allowed === undefined || allowed[managedDefault] === true
  );

  return {
    defaultPermission: configuredAllowed
      ? configuredDefault
      : managedAllowed ? managedDefault : null,
    permissions: permissionsResult.value,
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
