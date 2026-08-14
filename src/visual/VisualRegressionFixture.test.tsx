import { render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VisualRegressionFixture } from "./VisualRegressionFixture";

const getAnimationsDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "getAnimations",
);

beforeAll(() => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});

afterAll(() => {
  if (getAnimationsDescriptor === undefined) {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  } else {
    Object.defineProperty(
      Element.prototype,
      "getAnimations",
      getAnimationsDescriptor,
    );
  }
});

describe("VisualRegressionFixture", () => {
  it.each([
    ["conversation", "会话消息"],
    ["slash", "输入建议"],
    ["model", "选择模型"],
    ["settings", "设置分区"],
  ] as const)("稳定呈现 %s 场景", async (state, landmark) => {
    const { container } = render(<VisualRegressionFixture state={state} theme="dark" />);

    await waitFor(() => expect(screen.getByLabelText(landmark)).toBeVisible());
    await waitFor(() => expect(container.firstElementChild).toHaveAttribute("data-visual-ready", "true"));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });
});
