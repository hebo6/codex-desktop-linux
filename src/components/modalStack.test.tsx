import { useEffect } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useModalLayer } from "./modalStack";

function TestModal({ onEscape }: { readonly onEscape: () => void }) {
  const isTopmost = useModalLayer();
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isTopmost()) {
        onEscape();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isTopmost, onEscape]);
  return <div role="dialog" />;
}

describe("modal stack", () => {
  it("只允许最上层弹窗处理按键并在卸载后恢复下一层", () => {
    const lowerEscape = vi.fn();
    const upperEscape = vi.fn();
    const { rerender } = render(
      <>
        <TestModal key="lower" onEscape={lowerEscape} />
        <TestModal key="upper" onEscape={upperEscape} />
      </>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(lowerEscape).not.toHaveBeenCalled();
    expect(upperEscape).toHaveBeenCalledTimes(1);

    rerender(<TestModal key="lower" onEscape={lowerEscape} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(lowerEscape).toHaveBeenCalledTimes(1);
  });
});
