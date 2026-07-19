export type ResolvedLink =
  | ExtractedLink
  | { readonly type: "file"; readonly path: string; readonly line: number | null; readonly endLine: number | null; readonly column: number | null }
  | { readonly type: "anchor"; readonly id: string }
  | { readonly type: "blocked"; readonly reason: string };

export interface ExtractedLink {
  readonly type: "external";
  readonly url: string;
  readonly domain: string;
}

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:/u;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/u;

interface FileLocation {
  readonly line: number | null;
  readonly endLine: number | null;
  readonly column: number | null;
}

type ParsedLocation =
  | { readonly type: "none" }
  | { readonly type: "valid"; readonly value: FileLocation }
  | { readonly type: "invalid" };

type ParsedFileReference =
  | { readonly type: "valid"; readonly path: string; readonly location: FileLocation }
  | { readonly type: "invalid" };

export function resolveLink(raw: string, cwd: string | null): ResolvedLink {
  const value = raw.trim();
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return { type: "blocked", reason: "链接为空或包含控制字符" };
  }
  if (value.startsWith("#")) {
    return { type: "anchor", id: decodeSafely(value.slice(1)) };
  }
  if (/^https?:/iu.test(value)) {
    try {
      const url = new URL(value);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
        return { type: "blocked", reason: "网页链接包含不允许的认证信息" };
      }
      return { type: "external", url: url.href, domain: url.hostname };
    } catch {
      return { type: "blocked", reason: "网页链接格式无效" };
    }
  }
  if (/^file:/iu.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname.length > 0) {
        return { type: "blocked", reason: "不支持带主机名的文件链接" };
      }
      return resolveFileLink(decodeURIComponent(url.pathname), url.hash, null);
    } catch {
      return { type: "blocked", reason: "文件链接格式无效" };
    }
  }

  const { path, fragment } = splitFragment(value);
  const reference = parseFileReference(path, fragment);
  if (reference.type === "invalid") {
    return { type: "blocked", reason: "文件定位行列无效" };
  }
  if (SCHEME_PATTERN.test(reference.path) && !WINDOWS_ABSOLUTE_PATTERN.test(reference.path)) {
    return { type: "blocked", reason: "此链接协议不允许打开" };
  }
  if (isAbsolutePath(reference.path)) {
    return fileLink(normalizePath(reference.path), reference.location);
  }
  if (cwd === null) {
    return { type: "blocked", reason: "缺少服务器工作目录，无法解析相对路径" };
  }
  return fileLink(resolveRelativePath(cwd, reference.path), reference.location);
}

function resolveFileLink(path: string, fragment: string, cwd: string | null): ResolvedLink {
  const reference = parseFileReference(path, fragment);
  if (reference.type === "invalid") {
    return { type: "blocked", reason: "文件定位行列无效" };
  }
  const resolvedPath = isAbsolutePath(reference.path)
    ? normalizePath(reference.path)
    : cwd === null ? null : resolveRelativePath(cwd, reference.path);
  if (resolvedPath === null) {
    return { type: "blocked", reason: "缺少服务器工作目录，无法解析相对路径" };
  }
  return fileLink(resolvedPath, reference.location);
}

function fileLink(path: string, location: FileLocation): ResolvedLink {
  return { type: "file", path, ...location };
}

function splitFragment(value: string): { path: string; fragment: string } {
  const index = value.lastIndexOf("#");
  return index < 0
    ? { path: decodeSafely(value), fragment: "" }
    : { path: decodeSafely(value.slice(0, index)), fragment: value.slice(index) };
}

function parseLineFragment(fragment: string): ParsedLocation {
  const range = /^#L?(\d+)-L?(\d+)$/iu.exec(fragment);
  if (range !== null) {
    return location(range[1], null, range[2]);
  }
  const point = /^#L?(\d+)(?:C(\d+)|:(\d+))?$/iu.exec(fragment);
  if (point !== null) {
    return location(point[1], point[2] ?? point[3] ?? null, null);
  }
  return /^#L?\d/iu.test(fragment) ? { type: "invalid" } : { type: "none" };
}

function parseFileReference(path: string, fragment: string): ParsedFileReference {
  if (fragment.length === 0) {
    return parseLineSuffix(path);
  }
  const parsed = parseLineFragment(fragment);
  return parsed.type === "invalid"
    ? parsed
    : { type: "valid", path, location: parsed.type === "valid" ? parsed.value : emptyLocation() };
}

function parseLineSuffix(path: string): ParsedFileReference {
  const range = /^(.+):(\d+)-(\d+)$/u.exec(path);
  if (range !== null) {
    return fileReference(range[1], location(range[2], null, range[3]));
  }
  const pointWithColumn = /^(.+):(\d+):(\d+)$/u.exec(path);
  if (pointWithColumn !== null) {
    return fileReference(pointWithColumn[1], location(pointWithColumn[2], pointWithColumn[3], null));
  }
  const point = /^(.+):(\d+)$/u.exec(path);
  if (point !== null) {
    return fileReference(point[1], location(point[2], null, null));
  }
  return { type: "valid", path, location: emptyLocation() };
}

function fileReference(path: string | undefined, parsed: ParsedLocation): ParsedFileReference {
  return path === undefined || parsed.type === "invalid"
    ? { type: "invalid" }
    : { type: "valid", path, location: parsed.type === "valid" ? parsed.value : emptyLocation() };
}

function location(
  lineValue: string | undefined,
  columnValue: string | null | undefined,
  endLineValue: string | null | undefined,
): ParsedLocation {
  const line = positiveInteger(lineValue);
  const column = columnValue === null || columnValue === undefined
    ? null
    : positiveInteger(columnValue);
  const endLine = endLineValue === null || endLineValue === undefined
    ? null
    : positiveInteger(endLineValue);
  const invalidColumn = columnValue !== null && columnValue !== undefined && column === null;
  const invalidEndLine = endLineValue !== null && endLineValue !== undefined && endLine === null;
  if (line === null || invalidColumn || invalidEndLine || endLine !== null && endLine < line) {
    return { type: "invalid" };
  }
  return { type: "valid", value: { line, endLine, column } };
}

function positiveInteger(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function emptyLocation(): FileLocation {
  return { line: null, endLine: null, column: null };
}

function resolveRelativePath(cwd: string, path: string): string {
  const separator = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return normalizePath(`${cwd.replace(/[\\/]+$/u, "")}${separator}${path}`);
}

function normalizePath(path: string): string {
  const windows = WINDOWS_ABSOLUTE_PATTERN.test(path);
  const separator = windows && !path.includes("/") ? "\\" : "/";
  const prefix = windows ? path.slice(0, 2) : "";
  const parts = path.slice(windows ? 2 : 0).split(/[\\/]/u);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part.length === 0 || part === ".") {
      continue;
    }
    if (part === "..") {
      normalized.pop();
    } else {
      normalized.push(part);
    }
  }
  return windows
    ? `${prefix}${separator}${normalized.join(separator)}`
    : `/${normalized.join("/")}`;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || WINDOWS_ABSOLUTE_PATTERN.test(path);
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
