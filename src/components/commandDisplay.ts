import type { CommandExecutionThreadItem } from "../protocol/generated/types/ServerNotification";

type CommandActivity = Pick<CommandExecutionThreadItem, "command" | "commandActions" | "status">;

interface CommandActionDisplay {
  readonly command: string;
}

export function commandDisplayText(
  command: string,
  commandActions: readonly CommandActionDisplay[] | undefined,
): string {
  const parsedCommands = commandActions
    ?.map((action) => action.command.trim())
    .filter((parsedCommand) => parsedCommand.length > 0) ?? [];
  return parsedCommands.length === 0 ? command : parsedCommands.join(" · ");
}

export function commandActivityTitle(item: CommandActivity): string {
  if (item.commandActions.length === 0) {
    return rawCommandTitle(item.status, item.command);
  }
  return item.commandActions
    .map((action) => semanticCommandActionTitle(item.status, action))
    .join(" · ");
}

function semanticCommandActionTitle(
  status: CommandActivity["status"],
  action: CommandActivity["commandActions"][number],
): string {
  switch (action.type) {
    case "read":
      return `${semanticCommandVerb(status, "read")} ${action.name}`;
    case "listFiles":
      return action.path === undefined || action.path === null
        ? rawCommandTitle(status, action.command)
        : `${semanticCommandVerb(status, "listFiles")} ${action.path}`;
    case "search":
      return action.query === undefined || action.query === null ||
        action.path === undefined || action.path === null
        ? rawCommandTitle(status, action.command)
        : `${semanticCommandVerb(status, "search")} “${action.query}” in ${action.path}`;
    case "unknown":
      return rawCommandTitle(status, action.command);
  }
}

function semanticCommandVerb(
  status: CommandActivity["status"],
  type: "read" | "listFiles" | "search",
): string {
  const verbs = {
    read: {
      completed: "Read",
      declined: "Did not read",
      failed: "Failed to read",
      inProgress: "Reading",
    },
    listFiles: {
      completed: "Listed",
      declined: "Did not list",
      failed: "Failed to list",
      inProgress: "Listing",
    },
    search: {
      completed: "Searched",
      declined: "Did not search",
      failed: "Failed to search",
      inProgress: "Searching",
    },
  } as const;
  return verbs[type][status];
}

function rawCommandTitle(status: CommandActivity["status"], command: string): string {
  const verb = {
    completed: "Ran",
    declined: "Did not run",
    failed: "Failed to run",
    inProgress: "Running",
  } as const;
  return `${verb[status]} ${command}`;
}
