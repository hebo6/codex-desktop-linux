import type { TurnStartParams } from "../protocol/generated";
import type { StoredDraft } from "../transport/drafts";

type UserInput = TurnStartParams["input"][number];
type StructuredInput = StoredDraft["tokens"][number];
type MediaInput = Extract<UserInput, { type: "image" | "localImage" | "audio" | "localAudio" }>;

export function isMediaInput(input: UserInput): input is MediaInput {
  return input.type === "image" || input.type === "localImage"
    || input.type === "audio" || input.type === "localAudio";
}

export function hasDraftContent(draft: StoredDraft): boolean {
  return draft.text.length > 0 || draft.tokens.length > 0
    || draft.restoredInput?.some(isMediaInput) === true;
}

export function restoreQueuedDraft(input: TurnStartParams["input"]): StoredDraft {
  return {
    text: input.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n"),
    tokens: input.filter(isStructuredInput).map(({ type, name, path }) => ({ type, name, path })),
    restoredInput: input,
  };
}

export function draftToInput(draft: StoredDraft): TurnStartParams["input"] {
  const normalized = draft.text.trim();
  const textInput: TurnStartParams["input"] = normalized.length === 0
    ? []
    : [{ type: "text", text: normalized }];
  if (draft.restoredInput === undefined) return [...textInput, ...draft.tokens];

  const originalText = draft.restoredInput.filter((entry) => entry.type === "text");
  const textUnchanged = draft.text === originalText.map((entry) => entry.text).join("\n");
  const remainingTokens = [...draft.tokens];
  const input: TurnStartParams["input"] = [];
  let insertedText = false;
  if (originalText.length === 0) input.push(...textInput);
  for (const entry of draft.restoredInput) {
    if (entry.type === "text") {
      if (textUnchanged) input.push(entry);
      else if (!insertedText) {
        // Editing invalidates byte offsets in the original text elements.
        input.push(...textInput);
        insertedText = true;
      }
    } else if (isStructuredInput(entry)) {
      const index = remainingTokens.findIndex((token) => sameToken(token, entry));
      if (index !== -1) {
        input.push(entry);
        remainingTokens.splice(index, 1);
      }
    } else {
      input.push(entry);
    }
  }
  input.push(...remainingTokens);
  return input;
}

function isStructuredInput(input: UserInput): input is StructuredInput {
  return input.type === "skill" || input.type === "mention";
}

function sameToken(left: StructuredInput, right: StructuredInput): boolean {
  return left.type === right.type && left.name === right.name && left.path === right.path;
}
