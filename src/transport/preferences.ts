import { tauriIpc, type TauriIpc } from "./tauriIpc";

export type ThemePreference = "system" | "light" | "dark";

export interface AppPreferences {
  readonly theme: ThemePreference;
  readonly codeWrap: boolean;
  readonly sidebarWidth: number;
  readonly notifyTaskComplete: boolean;
  readonly notifyApproval: boolean;
  readonly notifyConnectionFailure: boolean;
}

export interface SystemDiagnostics {
  readonly clientVersion: string;
  readonly protocolBaseline: string;
  readonly operatingSystem: string;
  readonly architecture: string;
  readonly webviewVersion: string | null;
  readonly sessionType: string | null;
  readonly desktop: string | null;
}

export const DEFAULT_APP_PREFERENCES = Object.freeze({
  theme: "system",
  codeWrap: false,
  sidebarWidth: 288,
  notifyTaskComplete: false,
  notifyApproval: false,
  notifyConnectionFailure: false,
}) satisfies AppPreferences;

export interface PreferencesStore {
  load(): Promise<AppPreferences>;
  save(preferences: AppPreferences): Promise<AppPreferences>;
  clearThreadCache(): Promise<void>;
  clearApplicationLogs(): Promise<void>;
  clearTemporaryFiles(): Promise<void>;
  clearAllLocalData(): Promise<void>;
  readDiagnostics(): Promise<SystemDiagnostics>;
}

export function createPreferencesStore(
  ipc: Pick<TauriIpc, "invoke"> = tauriIpc,
): PreferencesStore {
  return {
    async load() {
      return parsePreferences(await ipc.invoke<unknown>("load_preferences", {}));
    },
    async save(preferences) {
      return parsePreferences(await ipc.invoke<unknown>("save_preferences", {
        request: { preferences },
      }));
    },
    async clearThreadCache() {
      await ipc.invoke<unknown>("clear_thread_cache", {});
    },
    async clearApplicationLogs() {
      await ipc.invoke<unknown>("clear_application_logs", {});
    },
    async clearTemporaryFiles() {
      await ipc.invoke<unknown>("clear_temporary_files", {});
    },
    async clearAllLocalData() {
      await ipc.invoke<unknown>("clear_all_local_data", {});
    },
    async readDiagnostics() {
      return parseSystemDiagnostics(await ipc.invoke<unknown>("read_system_diagnostics", {}));
    },
  };
}

export const preferencesStore = createPreferencesStore();

export function parsePreferences(value: unknown): AppPreferences {
  if (!isRecord(value)) throw new TypeError("invalid preferences response");
  return {
    theme: isTheme(value.theme) ? value.theme : DEFAULT_APP_PREFERENCES.theme,
    codeWrap: booleanOrDefault(value.codeWrap, DEFAULT_APP_PREFERENCES.codeWrap),
    sidebarWidth: sidebarWidthOrDefault(value.sidebarWidth),
    notifyTaskComplete: booleanOrDefault(value.notifyTaskComplete, DEFAULT_APP_PREFERENCES.notifyTaskComplete),
    notifyApproval: booleanOrDefault(value.notifyApproval, DEFAULT_APP_PREFERENCES.notifyApproval),
    notifyConnectionFailure: booleanOrDefault(value.notifyConnectionFailure, DEFAULT_APP_PREFERENCES.notifyConnectionFailure),
  };
}

function parseSystemDiagnostics(value: unknown): SystemDiagnostics {
  if (!isRecord(value)) throw new TypeError("invalid diagnostics response");
  return {
    clientVersion: requiredText(value.clientVersion),
    protocolBaseline: requiredText(value.protocolBaseline),
    operatingSystem: requiredText(value.operatingSystem),
    architecture: requiredText(value.architecture),
    webviewVersion: nullableText(value.webviewVersion),
    sessionType: nullableText(value.sessionType),
    desktop: nullableText(value.desktop),
  };
}

function isTheme(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function sidebarWidthOrDefault(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 240 && value <= 420
    ? value
    : DEFAULT_APP_PREFERENCES.sidebarWidth;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError("invalid diagnostics text");
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : requiredText(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
