const MAX_DATA_IMAGE_BYTES = 16 * 1024 * 1024;

const SUPPORTED_DATA_IMAGE_TYPES = Object.freeze({
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const);

interface ParsedDataImage {
  readonly dataBase64: string;
  readonly extension: (typeof SUPPORTED_DATA_IMAGE_TYPES)[keyof typeof SUPPORTED_DATA_IMAGE_TYPES];
  readonly mediaType: keyof typeof SUPPORTED_DATA_IMAGE_TYPES;
}

export interface DecodedDataImage extends ParsedDataImage {
  readonly blob: Blob;
  readonly name: string;
}

export function parseDataImageUrl(dataUrl: string): ParsedDataImage | null {
  const separator = dataUrl.indexOf(",");
  if (separator < 0) return null;
  const metadata = dataUrl.slice(0, separator).toLocaleLowerCase();
  if (!metadata.endsWith(";base64")) return null;
  const mediaType = metadata.slice("data:".length, -";base64".length);
  if (!Object.hasOwn(SUPPORTED_DATA_IMAGE_TYPES, mediaType)) return null;
  const dataBase64 = dataUrl.slice(separator + 1);
  if (!/^[a-z\d+/]*={0,2}$/iu.test(dataBase64)) return null;
  return {
    dataBase64,
    extension: SUPPORTED_DATA_IMAGE_TYPES[
      mediaType as keyof typeof SUPPORTED_DATA_IMAGE_TYPES
    ],
    mediaType: mediaType as keyof typeof SUPPORTED_DATA_IMAGE_TYPES,
  };
}

export function decodeDataImageUrl(dataUrl: string): DecodedDataImage | null {
  const parsed = parseDataImageUrl(dataUrl);
  if (
    parsed === null
    || decodedBase64Size(parsed.dataBase64) > MAX_DATA_IMAGE_BYTES
  ) {
    return null;
  }
  try {
    return {
      ...parsed,
      blob: new Blob(
        [decodeBase64Bytes(parsed.dataBase64)],
        { type: parsed.mediaType },
      ),
      name: `粘贴图片.${parsed.extension}`,
    };
  } catch {
    return null;
  }
}

export function decodeBase64Bytes(
  dataBase64: string,
): Uint8Array<ArrayBuffer> {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function decodedBase64Size(dataBase64: string): number {
  const padding = dataBase64.endsWith("==")
    ? 2
    : dataBase64.endsWith("=")
      ? 1
      : 0;
  return Math.max(0, Math.floor(dataBase64.length * 3 / 4) - padding);
}
