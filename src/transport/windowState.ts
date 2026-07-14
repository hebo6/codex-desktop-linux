import type { ServerId } from "../configuration";
import { listen } from "@tauri-apps/api/event";
import { tauriIpc } from "./tauriIpc";
import type { TauriIpc } from "./tauriIpc";

const LOAD_WINDOW_STATE_COMMAND = "load_window_state";
const BIND_WINDOW_SERVER_COMMAND = "bind_window_server";
const UPDATE_WINDOW_SESSION_COMMAND = "update_window_session";
const OPEN_APP_WINDOW_COMMAND = "open_app_window";
const WINDOW_SERVER_REFERENCES_CHANGED_EVENT =
  "window-server-references-changed";

const WINDOW_ID_PATTERN = /^(?=.{1,64}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const SERVER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_THREAD_ID_BYTES = 1_024;
const MAX_DRAFT_KEY_BYTES = 256;
const textEncoder = new TextEncoder();

export interface WindowState {
  readonly windowId: string;
  readonly version: number;
  readonly serverId?: ServerId;
  readonly currentThreadId?: string;
  readonly draftKey?: string;
  readonly updatedAtMs: number;
}

export interface BindWindowServerRequest {
  readonly expectedVersion: number;
  readonly serverId: ServerId | null;
}

export interface UpdateWindowSessionRequest {
  readonly expectedVersion: number;
  readonly currentThreadId: string | null;
  readonly draftKey: string | null;
}

export interface OpenAppWindowRequest {
  readonly serverId: ServerId;
  readonly threadId?: string;
}

export interface OpenAppWindowResponse {
  readonly windowId: string;
  readonly label: string;
}

export type WindowStateIpc = Pick<TauriIpc, "invoke">;

export interface WindowStateEventApi {
  listen(
    event: string,
    handler: (event: { readonly payload: unknown }) => void,
  ): Promise<() => void>;
}

export type WindowServerReferenceSubscriber = (
  onChange: () => void,
) => Promise<() => void>;

const tauriWindowStateEvents: WindowStateEventApi = {
  listen(event, handler) {
    return listen<unknown>(event, handler);
  },
};

export type WindowStateTransportErrorCode =
  "invalidRequest" | "invalidResponse" | "commandFailed";

export class WindowStateTransportError extends Error {
  readonly code: WindowStateTransportErrorCode;

  constructor(code: WindowStateTransportErrorCode) {
    super(`Window state transport failed: ${code}`);
    this.name = "WindowStateTransportError";
    this.code = code;
  }
}

export async function loadWindowState(
  ipc: WindowStateIpc = tauriIpc,
): Promise<WindowState> {
  const response = await invokeWindowCommand(
    ipc,
    LOAD_WINDOW_STATE_COMMAND,
    {},
  );
  return parseWindowState(response);
}

export async function bindWindowServer(
  request: BindWindowServerRequest,
  ipc: WindowStateIpc = tauriIpc,
): Promise<WindowState> {
  const normalizedRequest = normalizeBindWindowServerRequest(request);
  const response = await invokeWindowCommand(ipc, BIND_WINDOW_SERVER_COMMAND, {
    request: normalizedRequest,
  });
  const state = parseWindowState(response);
  if (
    !isIdempotentOrIncrementedVersion(
      state.version,
      normalizedRequest.expectedVersion,
    ) ||
    (state.serverId ?? null) !== normalizedRequest.serverId
  ) {
    throw new WindowStateTransportError("invalidResponse");
  }
  return state;
}

export async function updateWindowSession(
  request: UpdateWindowSessionRequest,
  ipc: WindowStateIpc = tauriIpc,
): Promise<WindowState> {
  const normalizedRequest = normalizeUpdateWindowSessionRequest(request);
  const response = await invokeWindowCommand(
    ipc,
    UPDATE_WINDOW_SESSION_COMMAND,
    { request: normalizedRequest },
  );
  const state = parseWindowState(response);
  if (
    !isIdempotentOrIncrementedVersion(
      state.version,
      normalizedRequest.expectedVersion,
    ) ||
    (state.currentThreadId ?? null) !== normalizedRequest.currentThreadId ||
    (state.draftKey ?? null) !== normalizedRequest.draftKey
  ) {
    throw new WindowStateTransportError("invalidResponse");
  }
  return state;
}

export async function openAppWindow(
  request: OpenAppWindowRequest,
  ipc: WindowStateIpc = tauriIpc,
): Promise<OpenAppWindowResponse> {
  const normalizedRequest = normalizeOpenAppWindowRequest(request);
  const response = await invokeWindowCommand(ipc, OPEN_APP_WINDOW_COMMAND, {
    request: normalizedRequest,
  });
  return parseOpenAppWindowResponse(response);
}

export async function subscribeWindowServerReferenceChanges(
  onChange: () => void,
  events: WindowStateEventApi = tauriWindowStateEvents,
): Promise<() => void> {
  return events.listen(WINDOW_SERVER_REFERENCES_CHANGED_EVENT, (event) => {
    if (!isEmptyRecord(event.payload)) {
      return;
    }
    try {
      onChange();
    } catch {
      // A view callback cannot break delivery of later authoritative events.
    }
  });
}

async function invokeWindowCommand(
  ipc: WindowStateIpc,
  command: string,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await ipc.invoke<unknown>(command, arguments_);
  } catch {
    throw new WindowStateTransportError("commandFailed");
  }
}

function normalizeBindWindowServerRequest(
  value: BindWindowServerRequest,
): BindWindowServerRequest {
  const record = expectExactRecord(
    value,
    ["expectedVersion", "serverId"],
    "invalidRequest",
  );
  const expectedVersion = expectVersion(
    record.expectedVersion,
    "invalidRequest",
  );
  const serverId =
    record.serverId === null
      ? null
      : expectServerId(record.serverId, "invalidRequest");
  return Object.freeze({ expectedVersion, serverId });
}

function normalizeUpdateWindowSessionRequest(
  value: UpdateWindowSessionRequest,
): UpdateWindowSessionRequest {
  const record = expectExactRecord(
    value,
    ["expectedVersion", "currentThreadId", "draftKey"],
    "invalidRequest",
  );
  return Object.freeze({
    expectedVersion: expectVersion(record.expectedVersion, "invalidRequest"),
    currentThreadId: expectNullableBoundedText(
      record.currentThreadId,
      MAX_THREAD_ID_BYTES,
      "invalidRequest",
    ),
    draftKey: expectNullableBoundedText(
      record.draftKey,
      MAX_DRAFT_KEY_BYTES,
      "invalidRequest",
    ),
  });
}

function normalizeOpenAppWindowRequest(
  value: OpenAppWindowRequest,
): OpenAppWindowRequest {
  const record = expectExactRecord(
    value,
    ["serverId", "threadId"],
    "invalidRequest",
    ["serverId"],
  );
  const request: { serverId: ServerId; threadId?: string } = {
    serverId: expectServerId(record.serverId, "invalidRequest"),
  };
  if (hasOwn(record, "threadId")) {
    request.threadId = expectBoundedText(
      record.threadId,
      MAX_THREAD_ID_BYTES,
      "invalidRequest",
    );
  }
  return Object.freeze(request);
}

function parseWindowState(value: unknown): WindowState {
  const record = expectExactRecord(
    value,
    [
      "windowId",
      "version",
      "serverId",
      "currentThreadId",
      "draftKey",
      "updatedAtMs",
    ],
    "invalidResponse",
    ["windowId", "version", "updatedAtMs"],
  );
  const state: {
    windowId: string;
    version: number;
    serverId?: ServerId;
    currentThreadId?: string;
    draftKey?: string;
    updatedAtMs: number;
  } = {
    windowId: expectWindowId(record.windowId),
    version: expectVersion(record.version, "invalidResponse"),
    updatedAtMs: expectTimestamp(record.updatedAtMs),
  };
  if (hasOwn(record, "serverId")) {
    state.serverId = expectServerId(record.serverId, "invalidResponse");
  }
  if (hasOwn(record, "currentThreadId")) {
    state.currentThreadId = expectBoundedText(
      record.currentThreadId,
      MAX_THREAD_ID_BYTES,
      "invalidResponse",
    );
  }
  if (hasOwn(record, "draftKey")) {
    state.draftKey = expectBoundedText(
      record.draftKey,
      MAX_DRAFT_KEY_BYTES,
      "invalidResponse",
    );
  }
  if (
    state.serverId === undefined &&
    (state.currentThreadId !== undefined || state.draftKey !== undefined)
  ) {
    throw new WindowStateTransportError("invalidResponse");
  }
  return Object.freeze(state);
}

function parseOpenAppWindowResponse(value: unknown): OpenAppWindowResponse {
  const record = expectExactRecord(
    value,
    ["windowId", "label"],
    "invalidResponse",
  );
  const windowId = expectWindowId(record.windowId);
  const label = expectNonEmptyString(record.label, "invalidResponse");
  if (label !== `app-${windowId}`) {
    throw new WindowStateTransportError("invalidResponse");
  }
  return Object.freeze({ windowId, label });
}

function expectExactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  code: "invalidRequest" | "invalidResponse",
  requiredKeys: readonly string[] = allowedKeys,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WindowStateTransportError(code);
  }
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new WindowStateTransportError(code);
  }
  if (
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !hasOwn(value, key))
  ) {
    throw new WindowStateTransportError(code);
  }
  return value as Record<string, unknown>;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isEmptyRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    return Reflect.ownKeys(value).length === 0;
  } catch {
    return false;
  }
}

function expectWindowId(value: unknown): string {
  if (typeof value !== "string" || !WINDOW_ID_PATTERN.test(value)) {
    throw new WindowStateTransportError("invalidResponse");
  }
  return value;
}

function expectServerId(
  value: unknown,
  code: "invalidRequest" | "invalidResponse",
): ServerId {
  if (typeof value !== "string" || !SERVER_ID_PATTERN.test(value)) {
    throw new WindowStateTransportError(code);
  }
  return value as ServerId;
}

function expectVersion(
  value: unknown,
  code: "invalidRequest" | "invalidResponse",
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new WindowStateTransportError(code);
  }
  return value as number;
}

function expectTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WindowStateTransportError("invalidResponse");
  }
  return value as number;
}

function expectNullableBoundedText(
  value: unknown,
  maximumBytes: number,
  code: "invalidRequest" | "invalidResponse",
): string | null {
  return value === null ? null : expectBoundedText(value, maximumBytes, code);
}

function expectBoundedText(
  value: unknown,
  maximumBytes: number,
  code: "invalidRequest" | "invalidResponse",
): string {
  const text = expectNonEmptyString(value, code);
  if (
    text.includes("\0") ||
    textEncoder.encode(text).byteLength > maximumBytes
  ) {
    throw new WindowStateTransportError(code);
  }
  return text;
}

function isIdempotentOrIncrementedVersion(
  actualVersion: number,
  expectedVersion: number,
): boolean {
  return (
    actualVersion === expectedVersion || actualVersion === expectedVersion + 1
  );
}

function expectNonEmptyString(
  value: unknown,
  code: "invalidRequest" | "invalidResponse",
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WindowStateTransportError(code);
  }
  return value;
}
