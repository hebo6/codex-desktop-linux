export function isEscapeDismissal(event: KeyboardEvent): boolean {
  return event.key === "Escape"
    && !event.defaultPrevented
    && !event.isComposing
    && !event.repeat;
}

export function isFocusTraversal(event: KeyboardEvent): boolean {
  return event.key === "Tab"
    && !event.defaultPrevented
    && !event.isComposing
    && !event.ctrlKey
    && !event.altKey
    && !event.metaKey;
}
