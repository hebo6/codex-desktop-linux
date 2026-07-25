import { useCallback, useRef, useState } from "react";

export interface ComposerSelection {
  readonly start: number;
  readonly end: number;
  readonly direction: "forward" | "backward" | "none";
}

export interface ComposerHistorySnapshot<Value> {
  readonly value: Value;
  readonly selection: ComposerSelection;
}

const MAX_HISTORY_ENTRIES = 100;
const DEFAULT_MERGE_WINDOW_MS = 1_000;

type ValueProducer<Value> = (current: Value) => Value;

export function useComposerHistory<Value>(
  initialValue: Value,
  initialSelection: ComposerSelection,
  valuesEqual: (left: Value, right: Value) => boolean,
) {
  const [value, setValue] = useState(initialValue);
  const valueRef = useRef(initialValue);
  const selectionRef = useRef(initialSelection);
  const valuesEqualRef = useRef(valuesEqual);
  const undoStackRef = useRef<ComposerHistorySnapshot<Value>[]>([]);
  const redoStackRef = useRef<ComposerHistorySnapshot<Value>[]>([]);
  const mergeRef = useRef<{ readonly key: string; readonly changedAt: number } | null>(null);
  valuesEqualRef.current = valuesEqual;

  const commit = useCallback((snapshot: ComposerHistorySnapshot<Value>) => {
    valueRef.current = snapshot.value;
    selectionRef.current = snapshot.selection;
    setValue(snapshot.value);
  }, []);

  const change = useCallback((
    produce: ValueProducer<Value>,
    selection: ComposerSelection,
    mergeKey: string | null = null,
    mergeWindowMs = DEFAULT_MERGE_WINDOW_MS,
  ) => {
    const current = valueRef.current;
    const next = produce(current);
    if (valuesEqualRef.current(current, next)) {
      selectionRef.current = selection;
      return false;
    }

    const changedAt = Date.now();
    const previousMerge = mergeRef.current;
    const mergeWithPrevious = mergeKey !== null
      && previousMerge?.key === mergeKey
      && changedAt - previousMerge.changedAt <= mergeWindowMs;
    if (!mergeWithPrevious) {
      pushBounded(undoStackRef.current, {
        value: current,
        selection: selectionRef.current,
      });
    }
    redoStackRef.current = [];
    mergeRef.current = mergeKey === null ? null : { key: mergeKey, changedAt };
    commit({ value: next, selection });
    return true;
  }, [commit]);

  const replace = useCallback((
    produce: ValueProducer<Value>,
    selection: ComposerSelection = selectionRef.current,
  ) => {
    const current = valueRef.current;
    const next = produce(current);
    mergeRef.current = null;
    if (valuesEqualRef.current(current, next)) {
      selectionRef.current = selection;
      return false;
    }
    commit({ value: next, selection });
    return true;
  }, [commit]);

  const reset = useCallback((next: Value, selection: ComposerSelection) => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    mergeRef.current = null;
    commit({ value: next, selection });
  }, [commit]);

  const undo = useCallback((): ComposerHistorySnapshot<Value> | null => {
    const previous = undoStackRef.current.pop();
    if (previous === undefined) {
      return null;
    }
    pushBounded(redoStackRef.current, {
      value: valueRef.current,
      selection: selectionRef.current,
    });
    mergeRef.current = null;
    commit(previous);
    return previous;
  }, [commit]);

  const redo = useCallback((): ComposerHistorySnapshot<Value> | null => {
    const next = redoStackRef.current.pop();
    if (next === undefined) {
      return null;
    }
    pushBounded(undoStackRef.current, {
      value: valueRef.current,
      selection: selectionRef.current,
    });
    mergeRef.current = null;
    commit(next);
    return next;
  }, [commit]);

  const rememberSelection = useCallback((selection: ComposerSelection) => {
    if (!selectionsEqual(selectionRef.current, selection)) {
      mergeRef.current = null;
      selectionRef.current = selection;
    }
  }, []);

  const getSelection = useCallback(() => selectionRef.current, []);

  const breakMerge = useCallback(() => {
    mergeRef.current = null;
  }, []);

  return {
    breakMerge,
    change,
    getSelection,
    redo,
    rememberSelection,
    replace,
    reset,
    undo,
    value,
  };
}

function pushBounded<Value>(
  stack: ComposerHistorySnapshot<Value>[],
  snapshot: ComposerHistorySnapshot<Value>,
): void {
  stack.push(snapshot);
  if (stack.length > MAX_HISTORY_ENTRIES) {
    stack.shift();
  }
}

function selectionsEqual(left: ComposerSelection, right: ComposerSelection): boolean {
  return left.start === right.start
    && left.end === right.end
    && left.direction === right.direction;
}
