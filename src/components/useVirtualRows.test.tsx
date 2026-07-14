import { renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { useVirtualRows } from "./useVirtualRows";

const OriginalResizeObserver = globalThis.ResizeObserver;

afterEach(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: OriginalResizeObserver,
  });
});

describe("useVirtualRows", () => {
  it("长列表只返回视口和过扫描范围", () => {
    class FakeResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: FakeResizeObserver,
    });
    const scrollerRef = createRef<HTMLElement>();
    const { result } = renderHook(() =>
      useVirtualRows({
        count: 1_000,
        estimateSize: () => 40,
        getKey: (index) => `row-${index}`,
        scrollerRef,
      }),
    );

    expect(result.current.virtualized).toBe(true);
    expect(result.current.rows.length).toBeLessThan(100);
    expect(result.current.totalSize).toBe(40_000);
  });
});
