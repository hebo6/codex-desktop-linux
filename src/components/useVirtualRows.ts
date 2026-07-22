import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

export interface VirtualRow {
  readonly index: number;
  readonly key: string;
  readonly size: number;
  readonly start: number;
}

interface VirtualRowsOptions {
  readonly count: number;
  readonly estimateSize: (index: number) => number;
  readonly getKey: (index: number) => string;
  readonly pinnedKeys?: ReadonlySet<string>;
  readonly scrollerRef: RefObject<HTMLElement | null>;
  readonly overscan?: number;
  readonly threshold?: number;
}

interface VirtualRowsResult {
  readonly rows: readonly VirtualRow[];
  readonly totalSize: number;
  readonly virtualized: boolean;
  readonly isMeasured: (key: string) => boolean;
  readonly measureElement: (key: string) => (element: HTMLElement | null) => void;
  readonly scrollToBottom: () => void;
  readonly scrollToIndex: (index: number) => void;
  readonly keyAtOffset: (offset: number) => string | null;
  readonly indexAtOffset: (offset: number) => number | null;
  readonly offsetForIndex: (index: number) => number | null;
}

interface ObservedElement {
  readonly element: HTMLElement;
  readonly observer: ResizeObserver;
}

export function useVirtualRows({
  count,
  estimateSize,
  getKey,
  pinnedKeys = EMPTY_KEYS,
  scrollerRef,
  overscan = 480,
  threshold = 40,
}: VirtualRowsOptions): VirtualRowsResult {
  const virtualized = typeof ResizeObserver !== "undefined" && count > threshold;
  const sizesRef = useRef(new Map<string, number>());
  const observersRef = useRef(new Map<string, ObservedElement>());
  const callbacksRef = useRef(
    new Map<string, (element: HTMLElement | null) => void>(),
  );
  const [measureVersion, setMeasureVersion] = useState(0);
  const [viewport, setViewport] = useState({ height: 800, top: 0 });

  const updateViewport = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    setViewport((current) => {
      const next = {
        height: Math.max(1, scroller.clientHeight),
        top: scroller.scrollTop,
      };
      return current.height === next.height && current.top === next.top
        ? current
        : next;
    });
  }, [scrollerRef]);

  useLayoutEffect(() => {
    if (!virtualized) {
      return;
    }
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    updateViewport();
    scroller.addEventListener("scroll", updateViewport, { passive: true });
    const observer = new ResizeObserver(updateViewport);
    observer.observe(scroller);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", updateViewport);
    };
  }, [scrollerRef, updateViewport, virtualized]);

  useLayoutEffect(
    () => () => {
      for (const observed of observersRef.current.values()) {
        observed.observer.disconnect();
      }
      observersRef.current.clear();
    },
    [],
  );

  const layout = useMemo(() => {
    const rows: VirtualRow[] = [];
    let start = 0;
    for (let index = 0; index < count; index += 1) {
      const key = getKey(index);
      const size = sizesRef.current.get(key) ?? estimateSize(index);
      rows.push({ index, key, size, start });
      start += size;
    }
    return { rows, totalSize: start };
  }, [count, estimateSize, getKey, measureVersion]);

  const rows = useMemo(() => {
    if (!virtualized) {
      return layout.rows;
    }
    const minimum = Math.max(0, viewport.top - overscan);
    const maximum = viewport.top + viewport.height + overscan;
    return layout.rows.filter(
      (row) =>
        pinnedKeys.has(row.key) ||
        (row.start + row.size >= minimum && row.start <= maximum),
    );
  }, [layout.rows, overscan, pinnedKeys, viewport, virtualized]);

  const measureElement = useCallback(
    (key: string) => {
      const cached = callbacksRef.current.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const callback = (element: HTMLElement | null) => {
        const current = observersRef.current.get(key);
        if (current?.element === element) {
          return;
        }
        current?.observer.disconnect();
        observersRef.current.delete(key);
        if (element === null || typeof ResizeObserver === "undefined") {
          return;
        }
        const recordSize = () => {
          const size = element.getBoundingClientRect().height;
          if (size <= 0 || Math.abs((sizesRef.current.get(key) ?? 0) - size) < 0.5) {
            return;
          }
          sizesRef.current.set(key, size);
          setMeasureVersion((version) => version + 1);
        };
        recordSize();
        const observer = new ResizeObserver(recordSize);
        observer.observe(element);
        observersRef.current.set(key, { element, observer });
      };
      callbacksRef.current.set(key, callback);
      return callback;
    },
    [],
  );

  const isMeasured = useCallback(
    (key: string) => sizesRef.current.has(key),
    [],
  );

  const scrollToBottom = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const height = Math.max(1, scroller.clientHeight);
    const top = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = top;
    setViewport((current) =>
      current.height === height && current.top === top
        ? current
        : { height, top }
    );
  }, [scrollerRef]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const scroller = scrollerRef.current;
      const row = layout.rows[index];
      if (scroller === null || row === undefined) {
        return;
      }
      const bottom = row.start + row.size;
      let top = scroller.scrollTop;
      if (row.start < top) {
        top = row.start;
      } else if (bottom > top + scroller.clientHeight) {
        top = bottom - scroller.clientHeight;
      }
      scroller.scrollTop = Math.max(0, top);
      setViewport((current) => ({ ...current, top: Math.max(0, top) }));
    },
    [layout.rows, scrollerRef],
  );

  const keyAtOffset = useCallback(
    (offset: number) =>
      layout.rows.find((row) => row.start + row.size >= offset)?.key ?? null,
    [layout.rows],
  );

  const indexAtOffset = useCallback(
    (offset: number) =>
      layout.rows.find((row) => row.start + row.size > offset)?.index ?? null,
    [layout.rows],
  );

  const offsetForIndex = useCallback(
    (index: number) => layout.rows[index]?.start ?? null,
    [layout.rows],
  );

  return {
    rows,
    totalSize: layout.totalSize,
    virtualized,
    isMeasured,
    measureElement,
    scrollToBottom,
    scrollToIndex,
    keyAtOffset,
    indexAtOffset,
    offsetForIndex,
  };
}

const EMPTY_KEYS = new Set<string>();
