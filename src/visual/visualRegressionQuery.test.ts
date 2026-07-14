import { describe, expect, it } from "vitest";

import { parseVisualRegressionQuery } from "./visualRegressionQuery";

describe("parseVisualRegressionQuery", () => {
  it("只接受完整且受控的视觉场景参数", () => {
    expect(parseVisualRegressionQuery("?visualFixture=conversation&theme=light")).toEqual({
      state: "conversation",
      theme: "light",
    });
    expect(parseVisualRegressionQuery("?visualFixture=model&theme=dark")).toEqual({
      state: "model",
      theme: "dark",
    });
    expect(parseVisualRegressionQuery("?visualFixture=unknown&theme=light")).toBeNull();
    expect(parseVisualRegressionQuery("?visualFixture=settings")).toBeNull();
  });
});
