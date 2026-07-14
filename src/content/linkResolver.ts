export type ResolvedLink =
  | ExtractedLink
  | { readonly type: "file"; readonly path: string; readonly line: number | null; readonly column: number | null }
  | { readonly type: "anchor"; readonly id: string }
  | { readonly type: "blocked"; readonly reason: string };

export interface ExtractedLink {
  readonly type: "external";
  readonly url: string;
  readonly domain: string;
}

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:/u;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/u;

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
      return fileLink(decodeURIComponent(url.pathname), url.hash);
    } catch {
      return { type: "blocked", reason: "文件链接格式无效" };
    }
  }
  if (SCHEME_PATTERN.test(value) && !WINDOWS_ABSOLUTE_PATTERN.test(value)) {
    return { type: "blocked", reason: "此链接协议不允许打开" };
  }

  const { path, fragment } = splitFragment(value);
  if (isAbsolutePath(path)) {
    return fileLink(normalizePath(path), fragment);
  }
  if (cwd === null) {
    return { type: "blocked", reason: "缺少服务器工作目录，无法解析相对路径" };
  }
  return fileLink(resolveRelativePath(cwd, path), fragment);
}

function fileLink(path: string, fragment: string): ResolvedLink {
  const location = parseLineFragment(fragment);
  return { type: "file", path, ...location };
}

function splitFragment(value: string): { path: string; fragment: string } {
  const index = value.lastIndexOf("#");
  return index < 0
    ? { path: decodeSafely(value), fragment: "" }
    : { path: decodeSafely(value.slice(0, index)), fragment: value.slice(index) };
}

function parseLineFragment(fragment: string): { line: number | null; column: number | null } {
  const match = /^#(?:L)?(\d+)(?::(\d+)|C(\d+))?/iu.exec(fragment);
  if (match === null) {
    return { line: null, column: null };
  }
  return {
    line: Number(match[1]),
    column: Number(match[2] ?? match[3] ?? 0) || null,
  };
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
