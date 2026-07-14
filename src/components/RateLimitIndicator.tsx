import { useEffect, useRef, useState } from "react";

import type { GetAccountRateLimitsResponse } from "../protocol/generated";
import {
  collectRemainingLimitWindows,
  mostUrgentLimitWindow,
  rateLimitAttention,
} from "../app/rateLimits";
import styles from "./RateLimitIndicator.module.css";

export interface RateLimitIndicatorProps {
  readonly data: GetAccountRateLimitsResponse | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly onRefresh: () => Promise<void>;
  readonly refreshing: boolean;
  readonly updatedAt: number | null;
}

export function RateLimitIndicator({
  data,
  error,
  loading,
  onRefresh,
  refreshing,
  updatedAt,
}: RateLimitIndicatorProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const windows = collectRemainingLimitWindows(data);
  const urgent = mostUrgentLimitWindow(windows);
  const percent = urgent?.remainingPercent ?? null;
  const attention = rateLimitAttention(percent);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={percent === null ? "账户剩余限额未知" : `账户剩余限额 ${percent}%`}
        className={styles.trigger}
        data-attention={attention}
        onClick={() => setOpen((current) => !current)}
        ref={buttonRef}
        title={percent === null ? "剩余限额未知" : `${urgent?.name}剩余 ${percent}%`}
        type="button"
      >
        <svg aria-hidden="true" className={styles.ring} viewBox="0 0 42 42">
          <circle className={styles.track} cx="21" cy="21" r="16" />
          <circle
            className={styles.value}
            cx="21"
            cy="21"
            pathLength="100"
            r="16"
            strokeDasharray={percent === null ? undefined : `${percent} ${100 - percent}`}
          />
        </svg>
        <span>{percent === null ? "—" : percent}</span>
      </button>
      {open ? (
        <section aria-label="账户剩余限额详情" className={styles.popover} role="dialog">
          <header>
            <div><strong>账户剩余限额</strong><small>{accountSummary(data)}</small></div>
            <button disabled={loading || refreshing} onClick={() => void onRefresh()} type="button">{refreshing ? "刷新中" : "刷新"}</button>
          </header>
          {windows.length === 0 ? (
            <p className={styles.empty}>{loading ? "正在读取限额" : error ?? "服务器未提供可展示的限额窗口"}</p>
          ) : (
            <div className={styles.windows}>
              {windows.map((window) => (
                <article data-attention={rateLimitAttention(window.remainingPercent)} key={window.id}>
                  <div className={styles.windowHeading}><strong>{window.name}</strong><span>{window.remainingPercent}% 剩余</span></div>
                  <div
                    aria-label={`${window.name}剩余 ${window.remainingPercent}%`}
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={window.remainingPercent}
                    className={styles.progress}
                    role="progressbar"
                  ><span style={{ width: `${window.remainingPercent}%` }} /></div>
                  <small>{formatResetTime(window.resetsAt)}</small>
                </article>
              ))}
            </div>
          )}
          {data?.rateLimitResetCredits && data.rateLimitResetCredits.availableCount > 0 ? (
            <p className={styles.credits}>可用限额重置次数 {data.rateLimitResetCredits.availableCount}</p>
          ) : null}
          {error === null || windows.length === 0 ? null : <p className={styles.stale} role="status">{error}，当前保留上次成功数据</p>}
          {updatedAt === null ? null : <footer>更新于 {new Date(updatedAt).toLocaleString()}</footer>}
        </section>
      ) : null}
    </div>
  );
}

function accountSummary(data: GetAccountRateLimitsResponse | null): string {
  if (data === null) return "等待服务器数据";
  const snapshots = Object.values(data.rateLimitsByLimitId ?? {});
  const snapshot = snapshots[0] ?? data.rateLimits;
  const parts: string[] = [];
  if (snapshot.planType) parts.push(`套餐 ${planName(snapshot.planType)}`);
  if (snapshot.credits?.unlimited) parts.push("点数不限量");
  else if (snapshot.credits?.balance) parts.push(`点数 ${snapshot.credits.balance}`);
  return parts.join(" · ") || "服务器账户";
}

function planName(plan: string): string {
  return plan === "self_serve_business_usage_based" ? "Business 用量计费"
    : plan === "enterprise_cbp_usage_based" ? "Enterprise 用量计费"
      : plan === "unknown" ? "未知" : plan;
}

function formatResetTime(timestamp: number | null): string {
  if (timestamp === null) return "重置时间未知";
  const reset = new Date(timestamp * 1000);
  const seconds = Math.round((reset.getTime() - Date.now()) / 1000);
  const [value, unit] = relativeUnit(seconds);
  const relative = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" }).format(value, unit);
  return `${relative}重置 · ${reset.toLocaleString()}`;
}

function relativeUnit(seconds: number): [number, Intl.RelativeTimeFormatUnit] {
  const absolute = Math.abs(seconds);
  if (absolute < 60) return [seconds, "second"];
  if (absolute < 3600) return [Math.round(seconds / 60), "minute"];
  if (absolute < 86_400) return [Math.round(seconds / 3600), "hour"];
  return [Math.round(seconds / 86_400), "day"];
}
