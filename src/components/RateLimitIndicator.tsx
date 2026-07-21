import { useEffect, useRef, useState } from "react";

import type {
  GetAccountRateLimitsResponse,
  GetAccountTokenUsageResponse,
} from "../protocol/generated";
import type { AccountTokenUsageDailyBucket } from "../protocol/generated/types/GetAccountTokenUsageResponse";
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
  readonly onConsumeResetCredit?: (creditId?: string | null) => Promise<void>;
  readonly resetting?: boolean;
  readonly tokenUsageData?: GetAccountTokenUsageResponse | null;
  readonly tokenUsageError?: string | null;
  readonly tokenUsageLoading?: boolean;
}

export function RateLimitIndicator({
  data,
  error,
  loading,
  onRefresh,
  refreshing,
  updatedAt,
  onConsumeResetCredit,
  resetting = false,
  tokenUsageData = null,
  tokenUsageError = null,
  tokenUsageLoading = false,
}: RateLimitIndicatorProps) {
  const [open, setOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(true);
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
          <div className={styles.historyContainer}>
            <button
              aria-expanded={historyOpen}
              className={styles.historyHeader}
              onClick={() => setHistoryOpen((prev) => !prev)}
              type="button"
            >
              <span>Token 历史消耗</span>
              <span className={`${styles.arrow} ${historyOpen ? styles.arrowOpen : ""}`}>▼</span>
            </button>
            {historyOpen ? (
              <div className={styles.historyDetails}>
                {tokenUsageLoading ? (
                  <div className={styles.historyMessage}>正在读取用量...</div>
                ) : tokenUsageError ? (
                  <div className={styles.historyMessage}>{tokenUsageError}</div>
                ) : !tokenUsageData?.dailyUsageBuckets || tokenUsageData.dailyUsageBuckets.length === 0 ? (
                  <div className={styles.historyMessage}>暂无历史用量数据</div>
                ) : (
                  <TokenUsageChart buckets={tokenUsageData.dailyUsageBuckets} />
                )}
              </div>
            ) : null}
          </div>
          {data?.rateLimitResetCredits && data.rateLimitResetCredits.availableCount > 0 ? (
            <div className={styles.creditsContainer}>
              <button
                aria-expanded={detailsOpen}
                className={styles.creditsHeader}
                onClick={() => setDetailsOpen((prev) => !prev)}
                type="button"
              >
                <span>可用限额重置次数 {data.rateLimitResetCredits.availableCount}</span>
                <span className={`${styles.arrow} ${detailsOpen ? styles.arrowOpen : ""}`}>▼</span>
              </button>
              {detailsOpen ? (
                <div className={styles.creditsDetails}>
                  {data.rateLimitResetCredits.credits === null || data.rateLimitResetCredits.credits === undefined ? (
                    <div className={styles.emptyDetails}>
                      <span>暂无详细凭证信息</span>
                      {onConsumeResetCredit ? (
                        <button
                          disabled={loading || refreshing || resetting}
                          onClick={() => {
                            if (window.confirm("确定要消耗一次重置次数来重置账户限额吗？")) {
                              void onConsumeResetCredit();
                            }
                          }}
                          type="button"
                        >
                          {resetting ? "重置中" : "快速重置"}
                        </button>
                      ) : null}
                    </div>
                  ) : data.rateLimitResetCredits.credits.length === 0 ? (
                    <div className={styles.emptyDetails}>暂无可用重置凭证</div>
                  ) : (
                    <div className={styles.creditList}>
                      {data.rateLimitResetCredits.credits.map((credit) => (
                        <div className={styles.creditItem} key={credit.id}>
                          <div className={styles.creditInfo}>
                            <strong>{credit.title || "限额重置凭证"}</strong>
                            {credit.description ? <small>{credit.description}</small> : null}
                            <span className={styles.expiry}>
                              {credit.expiresAt ? `${new Date(credit.expiresAt * 1000).toLocaleString()} 过期` : "永久有效"}
                            </span>
                          </div>
                          {onConsumeResetCredit && credit.status === "available" ? (
                            <button
                              disabled={loading || refreshing || resetting}
                              onClick={() => {
                                if (window.confirm(`确定要使用凭证“${credit.title || "限额重置凭证"}”重置限额吗？`)) {
                                  void onConsumeResetCredit(credit.id);
                                }
                              }}
                              type="button"
                            >
                              {resetting ? "重置中" : "使用"}
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
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

interface TokenUsageChartProps {
  readonly buckets: readonly AccountTokenUsageDailyBucket[];
}

function TokenUsageChart({ buckets }: TokenUsageChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  // 限制最多展示最近 14 天的数据以保证宽度合适
  const displayBuckets = buckets.slice(-14);

  const maxTokens = Math.max(...displayBuckets.map((b) => b.tokens), 0) || 1;

  const chartHeight = 85;
  const paddingBottom = 20;
  const paddingTop = 15;
  const plotHeight = chartHeight - paddingTop - paddingBottom;

  // 自适应 X 坐标计算
  const totalWidth = 320;
  const barCount = displayBuckets.length;
  const gap = 6;
  const barWidth = barCount > 0 ? (totalWidth - (barCount - 1) * gap) / barCount : 0;

  const activeBucket = hoveredIndex !== null ? displayBuckets[hoveredIndex] : null;

  return (
    <div className={styles.chartWrapper}>
      <div className={styles.chartHeader}>
        {activeBucket ? (
          <>
            <span className={styles.chartHeaderDate}>{formatChartDate(activeBucket.startDate)}</span>
            <span className={styles.chartHeaderValue}>{activeBucket.tokens.toLocaleString()} tokens</span>
          </>
        ) : (
          <span className={styles.chartHeaderTip}>悬停于柱状图查看每日消耗</span>
        )}
      </div>
      <svg className={styles.chartSvg} height={chartHeight} viewBox={`0 0 ${totalWidth} ${chartHeight}`} width="100%">
        {displayBuckets.map((bucket, index) => {
          const h = (bucket.tokens / maxTokens) * plotHeight;
          const x = index * (barWidth + gap);
          const y = chartHeight - paddingBottom - h;

          return (
            <g
              key={bucket.startDate}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              {/* 柱体背后的透明交互感应区，方便用户鼠标悬浮触碰 */}
              <rect
                fill="transparent"
                height={plotHeight + paddingTop}
                width={barWidth + gap}
                x={x - gap / 2}
                y={paddingTop}
                style={{ cursor: "pointer" }}
              />
              {/* 实际的柱子 */}
              <rect
                className={`${styles.chartBar} ${hoveredIndex === index ? styles.chartBarActive : ""}`}
                height={Math.max(h, 2)}
                rx="1.5"
                width={barWidth}
                x={x}
                y={y}
              />
              {/* 日期文本 */}
              {index % (barCount > 8 ? 2 : 1) === 0 ? (
                <text
                  className={styles.chartLabel}
                  dominantBaseline="hanging"
                  textAnchor="middle"
                  x={x + barWidth / 2}
                  y={chartHeight - paddingBottom + 4}
                >
                  {formatShortDate(bucket.startDate)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function formatChartDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}

function formatShortDate(dateStr: string): string {
  try {
    const parts = dateStr.split("-");
    if (parts.length >= 3) {
      return `${parts[1]}-${parts[2]}`;
    }
    return dateStr;
  } catch {
    return dateStr;
  }
}
