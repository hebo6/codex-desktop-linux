import type { GetAccountRateLimitsResponse } from "../protocol/generated";
import type { RateLimitSnapshot } from "../protocol/generated/types/GetAccountRateLimitsResponse";

export interface RemainingLimitWindow {
  readonly id: string;
  readonly name: string;
  readonly remainingPercent: number;
  readonly resetsAt: number | null;
  readonly windowDurationMins: number | null;
}

export function remainingPercent(usedPercent: number): number {
  return clampPercent(100 - usedPercent);
}

export function collectRemainingLimitWindows(
  response: GetAccountRateLimitsResponse | null,
): readonly RemainingLimitWindow[] {
  if (response === null) return [];
  const buckets = response.rateLimitsByLimitId === null || response.rateLimitsByLimitId === undefined || Object.keys(response.rateLimitsByLimitId).length === 0
    ? [[response.rateLimits.limitId ?? "default", response.rateLimits] as const]
    : Object.entries(response.rateLimitsByLimitId);
  const windows = buckets.flatMap(([bucketId, snapshot]) => snapshotWindows(bucketId, snapshot));
  return windows.sort((left, right) => left.remainingPercent - right.remainingPercent);
}

export function mostUrgentLimitWindow(
  windows: readonly RemainingLimitWindow[],
): RemainingLimitWindow | null {
  return windows.reduce<RemainingLimitWindow | null>(
    (lowest, window) => lowest === null || window.remainingPercent < lowest.remainingPercent ? window : lowest,
    null,
  );
}

export function mergeRateLimitUpdate(
  current: GetAccountRateLimitsResponse | null,
  update: RateLimitSnapshot,
): GetAccountRateLimitsResponse {
  if (current === null) {
    return {
      rateLimits: update,
      ...(update.limitId ? { rateLimitsByLimitId: { [update.limitId]: update } } : {}),
    };
  }
  const updateId = update.limitId ?? null;
  const currentId = current.rateLimits.limitId ?? null;
  const rateLimits = updateId === null || currentId === null || updateId === currentId
    ? mergeSnapshot(current.rateLimits, update)
    : current.rateLimits;
  const currentBuckets = current.rateLimitsByLimitId;
  const rateLimitsByLimitId = updateId === null
    ? currentBuckets
    : {
        ...(currentBuckets ?? {}),
        [updateId]: mergeSnapshot(currentBuckets?.[updateId] ?? {}, update),
      };
  return {
    ...current,
    rateLimits,
    ...(rateLimitsByLimitId === undefined ? {} : { rateLimitsByLimitId }),
  };
}

export function mergeRateLimitResponses(
  base: GetAccountRateLimitsResponse,
  newer: GetAccountRateLimitsResponse,
): GetAccountRateLimitsResponse {
  let merged = mergeRateLimitUpdate(base, newer.rateLimits);
  for (const snapshot of Object.values(newer.rateLimitsByLimitId ?? {})) {
    merged = mergeRateLimitUpdate(merged, snapshot);
  }
  return {
    ...merged,
    ...(newer.rateLimitResetCredits === undefined
      ? {}
      : { rateLimitResetCredits: newer.rateLimitResetCredits }),
  };
}

export function rateLimitAttention(
  value: number | null,
): "normal" | "warning" | "danger" | "unknown" {
  if (value === null) return "unknown";
  if (value <= 10) return "danger";
  if (value <= 25) return "warning";
  return "normal";
}

function snapshotWindows(
  bucketId: string,
  snapshot: RateLimitSnapshot,
): readonly RemainingLimitWindow[] {
  const bucketName = snapshot.limitName?.trim() || snapshot.limitId?.trim() || bucketId;
  const windows: RemainingLimitWindow[] = [];
  if (snapshot.primary !== null && snapshot.primary !== undefined) {
    windows.push({
      id: `${bucketId}:primary`,
      name: `${bucketName} · ${durationLabel(snapshot.primary.windowDurationMins, "主要窗口")}`,
      remainingPercent: remainingPercent(snapshot.primary.usedPercent),
      resetsAt: snapshot.primary.resetsAt ?? null,
      windowDurationMins: snapshot.primary.windowDurationMins ?? null,
    });
  }
  if (snapshot.secondary !== null && snapshot.secondary !== undefined) {
    windows.push({
      id: `${bucketId}:secondary`,
      name: `${bucketName} · ${durationLabel(snapshot.secondary.windowDurationMins, "次要窗口")}`,
      remainingPercent: remainingPercent(snapshot.secondary.usedPercent),
      resetsAt: snapshot.secondary.resetsAt ?? null,
      windowDurationMins: snapshot.secondary.windowDurationMins ?? null,
    });
  }
  if (snapshot.individualLimit !== null && snapshot.individualLimit !== undefined) {
    windows.push({
      id: `${bucketId}:individual`,
      name: `${bucketName} · 个人用量`,
      remainingPercent: clampPercent(snapshot.individualLimit.remainingPercent),
      resetsAt: snapshot.individualLimit.resetsAt,
      windowDurationMins: null,
    });
  }
  return windows;
}

function mergeSnapshot(base: RateLimitSnapshot, update: RateLimitSnapshot): RateLimitSnapshot {
  const merged = { ...base };
  for (const [key, value] of Object.entries(update)) {
    if (value !== null && value !== undefined) {
      Object.assign(merged, { [key]: value });
    }
  }
  return merged;
}

function durationLabel(minutes: number | null | undefined, fallback: string): string {
  if (minutes === null || minutes === undefined) return fallback;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天窗口`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时窗口`;
  return `${minutes} 分钟窗口`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
