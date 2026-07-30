import { describe, expect, it } from "vitest";

import {
  markdownFenceLanguageName,
  sourceLanguageForMarkdownFence,
} from "./syntaxLanguages";

describe("Markdown 代码围栏语言", () => {
  it.each([
    ["ts title=\"example.ts\"", "typescript", "TypeScript"],
    ["typescript", "typescript", "TypeScript"],
    ["JS", "javascript", "JavaScript"],
    ["py", "python", "Python"],
    ["yml", "yaml", "YAML"],
    ["c++", "cpp", "C++"],
    ["zsh", "bash", "Shell"],
  ])("识别 %s", (infoString, id, label) => {
    expect(sourceLanguageForMarkdownFence(infoString)).toEqual({ id, label });
  });

  it("只把 info string 的首个词视为语言", () => {
    expect(markdownFenceLanguageName("  TS  title=\"example.ts\"  "))
      .toBe("ts");
  });

  it.each(["", "text", "plaintext", "console", "unknown"])(
    "不为纯文本或未知语言 %s 指定高亮器",
    (infoString) => {
      expect(sourceLanguageForMarkdownFence(infoString)).toBeNull();
    },
  );
});
