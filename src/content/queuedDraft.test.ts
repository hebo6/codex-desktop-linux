import { describe, expect, it } from "vitest";
import type { TurnStartParams } from "../protocol/generated";
import { draftToInput, hasDraftContent, isMediaInput, restoreQueuedDraft } from "./queuedDraft";

const mixedInput = (): TurnStartParams["input"] => [
  { type: "text", text: "  !保留原文", text_elements: [{ byteRange: { start: 3, end: 9 }, placeholder: "保留" }], extension: { source: "queue" } },
  { type: "image", fileId: "file-id", detail: "original", extension: "file-image" },
  { type: "skill", name: "检查", path: "/tmp/skill", extension: "skill" },
  { type: "text", text: "下一段  ", text_elements: [] },
  { type: "image", url: "data:image/png;base64,IMAGE", detail: "high" },
  { type: "localImage", path: "/tmp/image.png", detail: "low" },
  { type: "audio", url: "data:audio/wav;base64,AUDIO", extension: "audio" },
  { type: "mention", name: "参考", path: "/tmp/reference", extension: "mention" },
  { type: "localAudio", path: "/tmp/audio.wav" },
];

describe("queuedDraft", () => {
  it("未修改时原样发送所有文本片段、元素、媒体和扩展字段", () => {
    const input = mixedInput();
    const draft = restoreQueuedDraft(input);
    expect(draft.text).toBe("  !保留原文\n下一段  ");
    expect(draft.tokens).toEqual([
      { type: "skill", name: "检查", path: "/tmp/skill" },
      { type: "mention", name: "参考", path: "/tmp/reference" },
    ]);
    expect(draft.restoredInput).toBe(input);
    expect(draftToInput(draft)).toEqual(input);
    expect(draftToInput(draft).every((entry, index) => entry === input[index])).toBe(true);
  });

  it("编辑文本合并片段并删除失效元素，保留非文本条目及顺序", () => {
    const input = mixedInput();
    const edited = { ...restoreQueuedDraft(input), text: "  修改后的文字  " };
    expect(draftToInput(edited)).toEqual([
      { type: "text", text: "修改后的文字" },
      ...input.filter((entry) => entry.type !== "text"),
    ]);
    expect(draftToInput({ ...edited, text: "" })).toEqual(input.filter((entry) => entry.type !== "text"));
  });

  it("删除和修改令牌按次数匹配，保留原顺序并在末尾添加新增令牌", () => {
    const token = { type: "mention" as const, name: "参考", path: "/tmp/reference" };
    const input: TurnStartParams["input"] = [
      { ...token, extension: "first" },
      { type: "image", fileId: "file-id" },
      { ...token, extension: "second" },
      { type: "skill", name: "旧技能", path: "/tmp/old", extension: "removed" },
      { type: "audio", url: "audio-url" },
    ];
    const draft = restoreQueuedDraft(input);
    const added = { type: "skill" as const, name: "新技能", path: "/tmp/new" };
    expect(draftToInput({ ...draft, tokens: [token, added] })).toEqual([
      input[0], input[1], input[4], added,
    ]);
    expect(draftToInput({ ...draft, tokens: [...draft.tokens, token] })).toEqual([...input, token]);
    expect(draftToInput({ ...draft, tokens: [] })).toEqual([input[1], input[4]]);
  });

  it("删除媒体不会使已删除文字和令牌复活", () => {
    const draft = restoreQueuedDraft(mixedInput());
    const emptied = {
      ...draft,
      text: "",
      tokens: [],
      restoredInput: draft.restoredInput!.filter((entry) => !isMediaInput(entry)),
    };
    expect(draftToInput(emptied)).toEqual([]);
    expect(hasDraftContent(emptied)).toBe(false);
  });

  it("只有媒体的草稿可保存与发送，新增文字放在媒体之前", () => {
    const media = mixedInput().filter(isMediaInput);
    const draft = restoreQueuedDraft(media);
    expect(hasDraftContent(draft)).toBe(true);
    expect(draftToInput(draft)).toEqual(media);
    expect(draftToInput({ ...draft, text: "新增说明" })).toEqual([
      { type: "text", text: "新增说明" }, ...media,
    ]);
  });

  it("普通草稿保持去除首尾空白的发送行为，草稿内容检测保留空格", () => {
    const token = { type: "skill" as const, name: "测试", path: "/tmp/test" };
    expect(draftToInput({ text: "  普通草稿  ", tokens: [token] })).toEqual([
      { type: "text", text: "普通草稿" }, token,
    ]);
    expect(draftToInput({ text: "  ", tokens: [] })).toEqual([]);
    expect(hasDraftContent({ text: "  ", tokens: [] })).toBe(true);
    expect(hasDraftContent({ text: "", tokens: [token] })).toBe(true);
    expect(hasDraftContent({ text: "", tokens: [] })).toBe(false);
  });
});
