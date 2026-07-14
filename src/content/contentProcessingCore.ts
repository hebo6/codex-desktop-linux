const MAX_FORMATTED_JSON_BYTES = 32 * 1024 * 1024;

export interface JsonFormatResult {
  readonly formatted: boolean;
  readonly text: string;
}

export function formatJsonContent(source: string): JsonFormatResult {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { formatted: false, text: source };
  }
  const formatted = JSON.stringify(value, null, 2);
  if (
    formatted === undefined ||
    new Blob([formatted]).size > MAX_FORMATTED_JSON_BYTES
  ) {
    return { formatted: false, text: source };
  }
  return { formatted: true, text: formatted };
}

export function findMatchingLines(
  source: string,
  query: string,
): Uint32Array<ArrayBuffer> {
  if (query.length === 0) return new Uint32Array(0);
  const normalizedQuery = query.toLocaleLowerCase();
  const matches: number[] = [];
  let lineNumber = 1;
  let start = 0;
  for (let index = 0; index <= source.length; index += 1) {
    if (index !== source.length && source.charCodeAt(index) !== 10) continue;
    const end = index > start && source.charCodeAt(index - 1) === 13
      ? index - 1
      : index;
    if (
      source.slice(start, end).toLocaleLowerCase().includes(normalizedQuery)
    ) {
      matches.push(lineNumber);
    }
    start = index + 1;
    lineNumber += 1;
  }
  return Uint32Array.from(matches);
}
