import { decodeBase64Bytes, decodedBase64Size } from "./dataImage";
import { sanitizeSvg } from "./sanitizeSvg";

const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;

export type DecodedPreview =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly blob: Blob; readonly sourceText?: string }
  | { readonly type: "binary" | "tooLarge" };

export function decodePreview(path: string, dataBase64: string): DecodedPreview {
  if (decodedBase64Size(dataBase64) > MAX_PREVIEW_BYTES) return { type: "tooLarge" };
  const extension = path.split(".").at(-1)?.toLocaleLowerCase() ?? "";
  const imageMediaType: Readonly<Record<string, string | undefined>> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  };
  try {
    if (extension === "svg") {
      const sourceText = decodeUtf8(dataBase64);
      return {
        type: "image",
        blob: new Blob([sanitizeSvg(sourceText)], { type: "image/svg+xml;charset=utf-8" }),
        sourceText,
      };
    }
    const mediaType = imageMediaType[extension];
    if (mediaType !== undefined) {
      return { type: "image", blob: new Blob([decodeBase64Bytes(dataBase64)], { type: mediaType }) };
    }
    const text = decodeUtf8(dataBase64);
    return text.includes("\0") ? { type: "binary" } : { type: "text", text };
  } catch {
    return { type: "binary" };
  }
}

function decodeUtf8(dataBase64: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Bytes(dataBase64));
}
