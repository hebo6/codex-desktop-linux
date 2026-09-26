// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex CLI 版本：codex-cli 0.157.1

export type UserInput =
  | TextUserInput
  | ImageUserInput
  | LocalImageUserInput
  | AudioUserInput
  | LocalAudioUserInput
  | SkillUserInput
  | MentionUserInput;
export type TextUserInputType = "text";
export type ImageUserInput = {
  detail?: ImageDetail | null;
  type: ImageUserInputType;
  [k: string]: unknown | undefined;
} & (UrlUserInput | FileIdUserInput);
export type ImageDetail = "auto" | "low" | "high" | "original";
export type ImageUserInputType = "image";
export type LocalImageUserInputType = "localImage";
export type AudioUserInputType = "audio";
export type LocalAudioUserInputType = "localAudio";
export type SkillUserInputType = "skill";
export type MentionUserInputType = "mention";

export interface ThreadQueueAddParams {
  clientUserMessageId: string;
  input: UserInput[];
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface TextUserInput {
  text: string;
  /**
   * UI-defined spans within `text` used to render or persist special elements.
   */
  text_elements?: TextElement[];
  type: TextUserInputType;
  [k: string]: unknown | undefined;
}
export interface TextElement {
  /**
   * Byte range in the parent `text` buffer that this element occupies.
   */
  byteRange: ByteRange;
  /**
   * Optional human-readable placeholder for the element, displayed in the UI.
   */
  placeholder?: string | null;
  [k: string]: unknown | undefined;
}
export interface ByteRange {
  end: number;
  start: number;
  [k: string]: unknown | undefined;
}
export interface UrlUserInput {
  url: string;
  [k: string]: unknown | undefined;
}
export interface FileIdUserInput {
  fileId: string;
  [k: string]: unknown | undefined;
}
export interface LocalImageUserInput {
  detail?: ImageDetail | null;
  path: string;
  type: LocalImageUserInputType;
  [k: string]: unknown | undefined;
}
export interface AudioUserInput {
  type: AudioUserInputType;
  url: string;
  [k: string]: unknown | undefined;
}
export interface LocalAudioUserInput {
  path: string;
  type: LocalAudioUserInputType;
  [k: string]: unknown | undefined;
}
export interface SkillUserInput {
  name: string;
  path: string;
  type: SkillUserInputType;
  [k: string]: unknown | undefined;
}
export interface MentionUserInput {
  name: string;
  path: string;
  type: MentionUserInputType;
  [k: string]: unknown | undefined;
}
