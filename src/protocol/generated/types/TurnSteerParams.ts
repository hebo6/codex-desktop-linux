// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export type AdditionalContextKind = "untrusted" | "application";
export type UserInput =
  TextUserInput | ImageUserInput | LocalImageUserInput | SkillUserInput | MentionUserInput;
export type TextUserInputType = "text";
export type ImageDetail = "auto" | "low" | "high" | "original";
export type ImageUserInputType = "image";
export type LocalImageUserInputType = "localImage";
export type SkillUserInputType = "skill";
export type MentionUserInputType = "mention";

export interface TurnSteerParams {
  /**
   * Optional client-provided context fragments keyed by an opaque source identifier.
   */
  additionalContext?: {
    [k: string]: AdditionalContextEntry | undefined;
  } | null;
  clientUserMessageId?: string | null;
  /**
   * Required active turn id precondition. The request fails when it does not match the currently active turn.
   */
  expectedTurnId: string;
  input: UserInput[];
  /**
   * Optional metadata to enrich Codex's ResponsesAPI turn metadata.
   *
   * Entries are flattened into the JSON string sent as `client_metadata["x-codex-turn-metadata"]` on ResponsesAPI HTTP and websocket requests.
   *
   * They are not sent as top-level ResponsesAPI `client_metadata` keys, and reserved keys such as `session_id`, `thread_id`, `turn_id`, and `window_id` cannot be overridden.
   */
  responsesapiClientMetadata?: {
    [k: string]: string | undefined;
  } | null;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface AdditionalContextEntry {
  kind: AdditionalContextKind;
  value: string;
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
export interface ImageUserInput {
  detail?: ImageDetail | null;
  type: ImageUserInputType;
  url: string;
  [k: string]: unknown | undefined;
}
export interface LocalImageUserInput {
  detail?: ImageDetail | null;
  path: string;
  type: LocalImageUserInputType;
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
