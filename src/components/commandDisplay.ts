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
