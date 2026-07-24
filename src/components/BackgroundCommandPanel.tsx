import { useEffect, useMemo, useRef, useState } from "react";

import type { ObservedBackgroundTerminal } from "../app/useBackgroundTerminals";
import type { ThreadTurn } from "../app/useServerThreads";
import styles from "./BackgroundCommandPanel.module.css";

type ThreadItem = ThreadTurn["items"][number];
type CommandExecutionItem = Extract<ThreadItem, { type: "commandExecution" }>;

interface RunningCommand {
  readonly command: string;
  readonly cwd: string;
  readonly durationMs: number;
  readonly itemId: string;
  readonly latestOutput: string | null;
  readonly locatable: boolean;
  readonly processId: string | null;
}

export interface BackgroundCommandPanelProps {
  readonly error: string | null;
  readonly loaded: boolean;
  readonly onLocate: (itemId: string) => void;
  readonly onTerminate: (processId: string) => void;
  readonly terminals: readonly ObservedBackgroundTerminal[];
  readonly terminatingProcessIds: ReadonlySet<string>;
  readonly turns: readonly ThreadTurn[];
}

export function BackgroundCommandPanel({
  error,
  loaded,
  onLocate,
  onTerminate,
  terminals,
  terminatingProcessIds,
  turns,
}: BackgroundCommandPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const fallbackObservedAtRef = useRef(new Map<string, number>());
  const commands = useMemo(
    () => runningCommands(
      terminals,
      turns,
      loaded,
      fallbackObservedAtRef.current,
      now,
    ),
    [loaded, now, terminals, turns],
  );

  useEffect(() => {
    if (commands.length === 0) {
      setExpanded(false);
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [commands.length]);

  if (commands.length === 0) {
    return null;
  }

  const longestDuration = Math.max(
    ...commands.map(({ durationMs }) => durationMs),
  );
  const summary = `${commands.length} 个命令正在运行 · ${formatDuration(longestDuration)}`;

  return (
    <section
      aria-label="运行中命令"
      aria-live="polite"
      className={styles.panel}
      data-expanded={expanded}
    >
      <button
        aria-expanded={expanded}
        className={styles.summary}
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span aria-hidden="true" className={styles.runningDot} />
        <strong>{summary}</strong>
        <span aria-hidden="true" className={styles.chevron}>›</span>
      </button>
      {expanded ? (
        <div className={styles.commandList}>
          {commands.map((command) => {
            const terminating = command.processId !== null &&
              terminatingProcessIds.has(command.processId);
            return (
              <article className={styles.command} key={command.itemId}>
                <div className={styles.commandCopy}>
                  <code title={command.command}>{command.command}</code>
                  <small title={command.cwd}>
                    {command.cwd} · {formatDuration(command.durationMs)}
                  </small>
                  {command.latestOutput === null ? null : (
                    <samp title={command.latestOutput}>
                      {command.latestOutput}
                    </samp>
                  )}
                </div>
                <div className={styles.actions}>
                  <button
                    disabled={!command.locatable}
                    onClick={() => onLocate(command.itemId)}
                    type="button"
                  >
                    定位
                  </button>
                  <button
                    disabled={command.processId === null || terminating}
                    onClick={() => {
                      if (command.processId !== null) {
                        onTerminate(command.processId);
                      }
                    }}
                    type="button"
                  >
                    {terminating ? "正在终止" : "终止"}
                  </button>
                </div>
              </article>
            );
          })}
          {error === null ? null : (
            <p className={styles.error} role="status">{error}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function runningCommands(
  terminals: readonly ObservedBackgroundTerminal[],
  turns: readonly ThreadTurn[],
  loaded: boolean,
  fallbackObservedAt: Map<string, number>,
  now: number,
): readonly RunningCommand[] {
  const items = new Map<string, CommandExecutionItem>();
  const activeItemIds = new Set<string>();
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === "commandExecution") {
        items.set(item.id, item);
        if (turn.status === "inProgress" && item.status === "inProgress") {
          activeItemIds.add(item.id);
        }
      }
    }
  }

  const visible = terminals.map((terminal) => {
    const item = items.get(terminal.itemId);
    return commandPresentation(
      terminal.itemId,
      terminal.processId,
      terminal.command,
      terminal.cwd,
      terminal.observedAt,
      item,
      now,
    );
  });
  const terminalItemIds = new Set(terminals.map(({ itemId }) => itemId));
  for (const item of items.values()) {
    if (
      item.status !== "inProgress" ||
      terminalItemIds.has(item.id) ||
      (loaded && !activeItemIds.has(item.id))
    ) {
      continue;
    }
    const observedAt = fallbackObservedAt.get(item.id) ?? now;
    fallbackObservedAt.set(item.id, observedAt);
    visible.push(commandPresentation(
      item.id,
      item.processId ?? null,
      item.command,
      item.cwd,
      observedAt,
      item,
      now,
    ));
  }
  return visible;
}

function commandPresentation(
  itemId: string,
  processId: string | null,
  command: string,
  cwd: string,
  observedAt: number,
  item: CommandExecutionItem | undefined,
  now: number,
): RunningCommand {
  return {
    command,
    cwd,
    durationMs: Math.max(
      0,
      (item?.durationMs ?? 0) + now - observedAt,
    ),
    itemId,
    latestOutput: latestOutputLine(item?.aggregatedOutput),
    locatable: item !== undefined,
    processId,
  };
}

function latestOutputLine(output: string | null | undefined): string | null {
  if (output === null || output === undefined) {
    return null;
  }
  const lines = output.trimEnd().split(/\r?\n/u);
  const latest = lines.findLast((line) => line.trim().length > 0)?.trim();
  return latest === undefined || latest.length === 0 ? null : latest;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0
      ? `${minutes} 分钟`
      : `${minutes} 分 ${remainingSeconds} 秒`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0
    ? `${hours} 小时`
    : `${hours} 小时 ${remainingMinutes} 分`;
}
