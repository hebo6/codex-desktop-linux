import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ObservedBackgroundTerminal } from "../app/useBackgroundTerminals";
import type { ThreadTurn } from "../app/useServerThreads";
import { AnsiCommandOutput } from "./AnsiCommandOutput";
import { ComposerAccessoryDisclosure } from "./ComposerAccessoryPanel";
import styles from "./BackgroundCommandPanel.module.css";

type ThreadItem = ThreadTurn["items"][number];
type CommandExecutionItem = Extract<ThreadItem, { type: "commandExecution" }>;

interface RunningCommand {
  readonly command: string;
  readonly cwd: string;
  readonly durationMs: number;
  readonly itemId: string;
  readonly locatable: boolean;
  readonly output: string | null;
  readonly processId: string | null;
}

const COMMAND_PANEL_DELAY_MS = 3_000;
const OUTPUT_BOTTOM_THRESHOLD_PX = 8;

export interface BackgroundCommandPanelProps {
  readonly error: string | null;
  readonly loaded: boolean;
  readonly onLocate: (itemId: string) => void;
  readonly onTerminate: (processId: string) => void;
  readonly onTerminateAll: (
    processIds: readonly string[],
  ) => Promise<void>;
  readonly terminals: readonly ObservedBackgroundTerminal[];
  readonly terminatingProcessIds: ReadonlySet<string>;
  readonly turns: readonly ThreadTurn[];
}

export function BackgroundCommandPanel({
  error,
  loaded,
  onLocate,
  onTerminate,
  onTerminateAll,
  terminals,
  terminatingProcessIds,
  turns,
}: BackgroundCommandPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [terminatingAll, setTerminatingAll] = useState(false);
  const fallbackObservedAtRef = useRef(new Map<string, number>());
  const running = useMemo(
    () => runningCommands(
      terminals,
      turns,
      loaded,
      fallbackObservedAtRef.current,
      now,
    ),
    [loaded, now, terminals, turns],
  );
  const commands = running.filter(
    ({ durationMs }) => durationMs >= COMMAND_PANEL_DELAY_MS,
  );

  useEffect(() => {
    if (running.length === 0) {
      setExpanded(false);
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running.length]);

  if (commands.length === 0) {
    return null;
  }
  const firstCommand = commands[0];
  if (firstCommand === undefined) {
    return null;
  }

  const longestDuration = Math.max(
    ...commands.map(({ durationMs }) => durationMs),
  );
  const summary = `${commands.length} 个命令正在运行 · ${
    formatDuration(longestDuration)
  } · ${firstCommand.command}`;
  const visibleProcessIds = commandProcessIds(commands);
  const allProcessIds = commandProcessIds(running);
  const anyCommandTerminating = allProcessIds.some((processId) =>
    terminatingProcessIds.has(processId)
  );

  return (
    <ComposerAccessoryDisclosure
      expanded={expanded}
      icon={<span className={styles.runningDot} />}
      label="运行中命令"
      live="polite"
      onExpandedChange={setExpanded}
      summary={summary}
    >
      <div className={styles.commandList}>
        {visibleProcessIds.length < 2 ? null : (
          <div className={styles.bulkActions}>
            <button
              className={styles.terminateAction}
              disabled={terminatingAll || anyCommandTerminating}
              onClick={() => {
                setTerminatingAll(true);
                void onTerminateAll(allProcessIds).then(
                  () => setTerminatingAll(false),
                  () => setTerminatingAll(false),
                );
              }}
              type="button"
            >
              {terminatingAll ? "正在终止所有命令" : "终止所有命令"}
            </button>
          </div>
        )}
        {commands.map((command) => {
          const terminating = command.processId !== null &&
            terminatingProcessIds.has(command.processId);
          return (
            <article className={styles.command} key={command.itemId}>
              <div className={styles.commandHeader}>
                <div className={styles.commandCopy}>
                  <code>{command.command}</code>
                  <small title={command.cwd}>
                    {command.cwd} · {formatDuration(command.durationMs)}
                  </small>
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
                    className={styles.terminateAction}
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
              </div>
              {command.output === null ? null : (
                <CommandOutput expanded={expanded} output={command.output} />
              )}
            </article>
          );
        })}
        {error === null ? null : (
          <p className={styles.error} role="status">{error}</p>
        )}
      </div>
    </ComposerAccessoryDisclosure>
  );
}

function CommandOutput({
  expanded,
  output,
}: {
  readonly expanded: boolean;
  readonly output: string;
}) {
  const outputRef = useRef<HTMLElement>(null);
  const followingRef = useRef(true);
  const previousOutputRef = useRef(output);
  const [following, setFollowing] = useState(true);
  const [hasNewOutput, setHasNewOutput] = useState(false);

  useLayoutEffect(() => {
    const element = outputRef.current;
    const outputChanged = previousOutputRef.current !== output;
    previousOutputRef.current = output;
    if (element === null) {
      return;
    }
    if (!expanded) {
      if (outputChanged && !followingRef.current) {
        setHasNewOutput(true);
      }
      return;
    }
    if (followingRef.current) {
      element.scrollTop = Math.max(
        0,
        element.scrollHeight - element.clientHeight,
      );
      setHasNewOutput(false);
      return;
    }
    if (outputChanged) {
      setHasNewOutput(true);
    }
  }, [expanded, output]);

  const updateFollowing = (nextFollowing: boolean) => {
    followingRef.current = nextFollowing;
    setFollowing(nextFollowing);
    if (nextFollowing) {
      setHasNewOutput(false);
    }
  };

  const scrollToLatest = () => {
    const element = outputRef.current;
    if (element === null) {
      return;
    }
    updateFollowing(true);
    element.scrollTop = Math.max(
      0,
      element.scrollHeight - element.clientHeight,
    );
  };

  return (
    <div className={styles.output}>
      <AnsiCommandOutput
        aria-label="命令输出"
        onScroll={(event) => {
          const element = event.currentTarget;
          const distanceToBottom = element.scrollHeight -
            element.scrollTop -
            element.clientHeight;
          updateFollowing(distanceToBottom <= OUTPUT_BOTTOM_THRESHOLD_PX);
        }}
        output={output}
        ref={outputRef}
      />
      {following ? null : (
        <button
          aria-label={hasNewOutput ? "有新输出，回到最新" : "回到最新输出"}
          aria-live="polite"
          className={styles.returnToLatest}
          onClick={scrollToLatest}
          type="button"
        >
          {hasNewOutput ? "有新输出" : "回到最新"}
          <span aria-hidden="true">↓</span>
        </button>
      )}
    </div>
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
    command: displayCommand(command, item),
    cwd,
    durationMs: Math.max(
      0,
      (item?.durationMs ?? 0) + now - observedAt,
    ),
    itemId,
    locatable: item !== undefined,
    output: commandOutput(item?.aggregatedOutput),
    processId,
  };
}

function displayCommand(
  command: string,
  item: CommandExecutionItem | undefined,
): string {
  const parsedCommands = item?.commandActions
    .map((action) => action.command.trim())
    .filter((parsedCommand) => parsedCommand.length > 0) ?? [];
  return parsedCommands.length === 0 ? command : parsedCommands.join(" · ");
}

function commandOutput(output: string | null | undefined): string | null {
  if (output === null || output === undefined) {
    return null;
  }
  return output.length === 0 ? null : output;
}

function commandProcessIds(commands: readonly RunningCommand[]): string[] {
  return Array.from(new Set(commands.flatMap(({ processId }) =>
    processId === null ? [] : [processId]
  )));
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
