import { describe, expect, it } from "vitest";

import { findMatchingLines, formatJsonContent } from "./contentProcessingCore";

describe("content processing worker core", () => {
  it("格式化有效 JSON 并原样保留无效内容", () => {
    expect(formatJsonContent('{"value":[1,2]}')).toEqual({
      formatted: true,
      text: '{\n  "value": [\n    1,\n    2\n  ]\n}',
    });
    expect(formatJsonContent("not-json")).toEqual({
      formatted: false,
      text: "not-json",
    });
  });

  it("在 Worker 核心中完成不区分大小写的全文件行搜索", () => {
    expect([...findMatchingLines("Alpha\r\nbeta alpha\ngamma", "ALPHA")]).toEqual([
      1, 2,
    ]);
    expect([...findMatchingLines("content", "")]).toEqual([]);
  });
});
