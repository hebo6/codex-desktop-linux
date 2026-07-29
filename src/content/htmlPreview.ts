import {
  decodeBase64Bytes,
  decodedBase64Size,
  parseDataImageUrl,
} from "./dataImage";
import { sanitizeSvg } from "./sanitizeSvg";

const MAX_RESOURCE_COUNT = 64;
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_RESOURCE_BYTES = 32 * 1024 * 1024;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/u;
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:/u;

const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src blob:",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src blob:",
  "manifest-src 'none'",
  "media-src 'none'",
  "navigate-to 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src blob:",
  "worker-src 'none'",
].join("; ");

export interface HtmlPreviewFile {
  readonly dataBase64: string;
  readonly isFile: boolean;
  readonly isSymlink: boolean;
}

export interface PreparedHtmlPreview {
  readonly blockedResourceCount: number;
  readonly html: string;
}

export async function prepareHtmlPreview({
  createBlobUrl,
  documentPath,
  loadFile,
  source,
  workspacePath,
}: {
  readonly createBlobUrl: (blob: Blob) => string;
  readonly documentPath: string;
  readonly loadFile: (path: string) => Promise<HtmlPreviewFile>;
  readonly source: string;
  readonly workspacePath: string | null;
}): Promise<PreparedHtmlPreview> {
  const documentNode = new DOMParser().parseFromString(source, "text/html");
  let blockedResourceCount = 0;
  let resourceCount = 0;
  let totalResourceBytes = 0;
  const resourceCache = new Map<string, Promise<string | null>>();

  const blocked = (): null => {
    blockedResourceCount += 1;
    return null;
  };

  const loadResourcePath = (
    path: string,
    purpose: ResourcePurpose,
  ): Promise<string | null> => {
    const key = `${purpose}:${path}`;
    const cached = resourceCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const loading = (async () => {
      if (resourceCount >= MAX_RESOURCE_COUNT) {
        return blocked();
      }
      resourceCount += 1;
      try {
        const file = await loadFile(path);
        if (!file.isFile || file.isSymlink) {
          return blocked();
        }
        const size = decodedBase64Size(file.dataBase64);
        if (
          size > MAX_RESOURCE_BYTES ||
          totalResourceBytes + size > MAX_TOTAL_RESOURCE_BYTES
        ) {
          return blocked();
        }
        const mediaType = resourceMediaType(path, purpose);
        if (mediaType === null) {
          return blocked();
        }
        totalResourceBytes += size;
        if (mediaType === "text/css") {
          const css = decodeUtf8(file.dataBase64);
          const rewritten = await rewriteCss(css, path);
          return createBlobUrl(new Blob([rewritten], { type: mediaType }));
        }
        if (mediaType === "image/svg+xml") {
          const svg = sanitizeSvg(decodeUtf8(file.dataBase64));
          return createBlobUrl(new Blob([svg], { type: mediaType }));
        }
        return createBlobUrl(new Blob(
          [decodeBase64Bytes(file.dataBase64)],
          { type: mediaType },
        ));
      } catch {
        return blocked();
      }
    })();
    resourceCache.set(key, loading);
    return loading;
  };

  const loadResourceReference = async (
    raw: string,
    basePath: string,
    purpose: ResourcePurpose,
  ): Promise<string | null> => {
    const value = raw.trim();
    if (/^data:/iu.test(value)) {
      const parsed = purpose === "stylesheet"
        ? null
        : parseDataImageUrl(value);
      if (parsed === null) {
        return blocked();
      }
      const size = decodedBase64Size(parsed.dataBase64);
      if (
        resourceCount >= MAX_RESOURCE_COUNT ||
        size > MAX_RESOURCE_BYTES ||
        totalResourceBytes + size > MAX_TOTAL_RESOURCE_BYTES
      ) {
        return blocked();
      }
      resourceCount += 1;
      totalResourceBytes += size;
      try {
        return createBlobUrl(new Blob(
          [decodeBase64Bytes(parsed.dataBase64)],
          { type: parsed.mediaType },
        ));
      } catch {
        return blocked();
      }
    }
    const path = resolveWorkspaceResource(value, basePath, workspacePath);
    return path === null ? blocked() : loadResourcePath(path, purpose);
  };

  const rewriteCss = async (
    css: string,
    basePath: string,
  ): Promise<string> => {
    const withoutImports = css.replace(
      /@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;/giu,
      () => {
        blockedResourceCount += 1;
        return "";
      },
    );
    return replaceAsync(
      withoutImports,
      /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/giu,
      async (match) => {
        const raw = (match[2] ?? match[3] ?? "").trim();
        if (raw.startsWith("#")) {
          return match[0];
        }
        const url = await loadResourceReference(raw, basePath, "asset");
        return url === null ? 'url("data:,")' : `url("${url}")`;
      },
    );
  };

  documentNode
    .querySelectorAll(
      "script, iframe, frame, frameset, object, embed, applet, portal, base, meta[http-equiv]",
    )
    .forEach((node) => node.remove());

  for (const element of documentNode.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLocaleLowerCase();
      if (
        name.startsWith("on") ||
        name === "srcdoc" ||
        name === "nonce" ||
        name === "integrity" ||
        name === "ping"
      ) {
        element.removeAttribute(attribute.name);
      }
    }
    element.removeAttribute("autofocus");
  }

  await Promise.all(
    [...documentNode.querySelectorAll("link[href]")].map(async (link) => {
      const relations = link.rel.toLocaleLowerCase().split(/\s+/u);
      if (!relations.includes("stylesheet")) {
        link.remove();
        return;
      }
      const raw = link.getAttribute("href") ?? "";
      const url = await loadResourceReference(raw, documentPath, "stylesheet");
      if (url === null) {
        link.remove();
      } else {
        link.setAttribute("href", url);
        link.removeAttribute("crossorigin");
        link.removeAttribute("referrerpolicy");
      }
    }),
  );

  await Promise.all(
    [...documentNode.querySelectorAll("img[src]")].map(async (image) => {
      const raw = image.getAttribute("src") ?? "";
      const url = await loadResourceReference(raw, documentPath, "image");
      if (url === null) {
        image.removeAttribute("src");
      } else {
        image.setAttribute("src", url);
      }
      image.removeAttribute("crossorigin");
      image.removeAttribute("referrerpolicy");
      image.removeAttribute("srcset");
    }),
  );

  documentNode.querySelectorAll("source, track").forEach((node) => node.remove());
  for (const element of documentNode.querySelectorAll("[srcset]")) {
    element.removeAttribute("srcset");
  }
  for (const element of documentNode.querySelectorAll("[poster], [background]")) {
    element.removeAttribute("poster");
    element.removeAttribute("background");
  }
  for (const element of documentNode.querySelectorAll("[src]")) {
    if (element.tagName.toLocaleLowerCase() !== "img") {
      element.removeAttribute("src");
    }
  }

  const embeddedStyleSheets = await Promise.all(
    [...documentNode.querySelectorAll("style")].map(async (style) => {
      const css = await rewriteCss(style.textContent ?? "", documentPath);
      const media = style.getAttribute("media");
      style.remove();
      return media === null || !/^[\w\s(),.:/-]+$/u.test(media)
        ? css
        : `@media ${media}{${css}}`;
    }),
  );
  const inlineStyleRules = await Promise.all(
    [...documentNode.querySelectorAll("[style]")].map(
      async (element, index) => {
        const style = element.getAttribute("style") ?? "";
        const marker = String(index);
        element.removeAttribute("style");
        element.setAttribute("data-codex-preview-style", marker);
        const declarations = await rewriteCss(style, documentPath);
        return `[data-codex-preview-style="${marker}"]:not(#codex-preview-inline-a#codex-preview-inline-b#codex-preview-inline-c#codex-preview-inline-d){${declarations}}`;
      },
    ),
  );
  const generatedStyles = [...embeddedStyleSheets, ...inlineStyleRules];
  if (generatedStyles.length > 0) {
    const link = documentNode.createElement("link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute(
      "href",
      createBlobUrl(new Blob(
        [generatedStyles.join("\n")],
        { type: "text/css" },
      )),
    );
    documentNode.head.append(link);
  }

  for (const form of documentNode.querySelectorAll("form")) {
    form.removeAttribute("action");
    form.removeAttribute("method");
    form.removeAttribute("target");
  }
  for (const control of documentNode.querySelectorAll("[formaction]")) {
    control.removeAttribute("formaction");
  }

  for (const anchor of documentNode.querySelectorAll("a[href]")) {
    const raw = anchor.getAttribute("href") ?? "";
    anchor.removeAttribute("download");
    anchor.removeAttribute("target");
    anchor.removeAttribute("rel");
    if (raw.startsWith("#") && !/[\u0000-\u001f\u007f]/u.test(raw)) {
      continue;
    }
    const target = resolveNavigationTarget(raw, documentPath);
    anchor.setAttribute("href", "#");
    if (target === null) {
      anchor.removeAttribute("data-preview-link");
    } else {
      anchor.setAttribute("data-preview-link", target);
      anchor.setAttribute("title", raw);
    }
  }

  for (const element of documentNode.querySelectorAll("[href]")) {
    const name = element.tagName.toLocaleLowerCase();
    const href = element.getAttribute("href") ?? "";
    if (
      name !== "a" &&
      name !== "link" &&
      !href.startsWith("#")
    ) {
      element.removeAttribute("href");
    }
  }

  const csp = documentNode.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", HTML_PREVIEW_CSP);
  documentNode.head.prepend(csp);
  const referrer = documentNode.createElement("meta");
  referrer.setAttribute("name", "referrer");
  referrer.setAttribute("content", "no-referrer");
  csp.after(referrer);

  return {
    blockedResourceCount,
    html: `<!doctype html>\n${documentNode.documentElement.outerHTML}`,
  };
}

type ResourcePurpose = "asset" | "image" | "stylesheet";

function resourceMediaType(
  path: string,
  purpose: ResourcePurpose,
): string | null {
  const extension = path
    .split(/[\\/]/u)
    .at(-1)
    ?.split(".")
    .at(-1)
    ?.toLocaleLowerCase() ?? "";
  if (purpose === "stylesheet") {
    return extension === "css" ? "text/css" : null;
  }
  const images: Readonly<Record<string, string | undefined>> = {
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
  };
  const image = images[extension];
  if (image !== undefined) {
    return image;
  }
  if (purpose === "image") {
    return null;
  }
  const assets: Readonly<Record<string, string | undefined>> = {
    otf: "font/otf",
    ttf: "font/ttf",
    woff: "font/woff",
    woff2: "font/woff2",
  };
  return assets[extension] ?? null;
}

function resolveWorkspaceResource(
  reference: string,
  basePath: string,
  workspacePath: string | null,
): string | null {
  if (
    workspacePath === null ||
    reference.length === 0 ||
    reference.startsWith("#") ||
    reference.startsWith("/") ||
    reference.startsWith("\\") ||
    reference.startsWith("//") ||
    WINDOWS_ABSOLUTE_PATTERN.test(reference) ||
    SCHEME_PATTERN.test(reference) ||
    /[\u0000-\u001f\u007f]/u.test(reference)
  ) {
    return null;
  }
  const pathPart = reference.split(/[?#]/u, 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  if (
    decoded.length === 0 ||
    decoded.startsWith("/") ||
    decoded.startsWith("\\") ||
    WINDOWS_ABSOLUTE_PATTERN.test(decoded) ||
    SCHEME_PATTERN.test(decoded) ||
    /[\u0000-\u001f\u007f]/u.test(decoded)
  ) {
    return null;
  }
  const resolved = normalizeRemotePath(
    `${remoteDirectoryName(basePath)}/${decoded}`,
  );
  return isPathWithinWorkspace(resolved, workspacePath) ? resolved : null;
}

function resolveNavigationTarget(
  reference: string,
  basePath: string,
): string | null {
  const value = reference.trim();
  if (
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /^javascript:/iu.test(value) ||
    /^data:/iu.test(value)
  ) {
    return null;
  }
  if (value.startsWith("//")) {
    return `https:${value}`;
  }
  if (
    SCHEME_PATTERN.test(value) ||
    value.startsWith("/") ||
    WINDOWS_ABSOLUTE_PATTERN.test(value)
  ) {
    return value;
  }
  const hashIndex = value.indexOf("#");
  const fragment = hashIndex < 0 ? "" : value.slice(hashIndex);
  const pathWithQuery = hashIndex < 0 ? value : value.slice(0, hashIndex);
  const pathPart = pathWithQuery.split("?", 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  return `${normalizeRemotePath(
    `${remoteDirectoryName(basePath)}/${decoded}`,
  )}${fragment}`;
}

function normalizeRemotePath(path: string): string {
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

function remoteDirectoryName(path: string): string {
  const normalized = normalizeRemotePath(path);
  const index = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  if (index < 0) {
    return normalized;
  }
  if (index === 0) {
    return "/";
  }
  if (index === 2 && WINDOWS_ABSOLUTE_PATTERN.test(normalized)) {
    return normalized.slice(0, 3);
  }
  return normalized.slice(0, index);
}

function isPathWithinWorkspace(path: string, workspacePath: string): boolean {
  const normalizedPath = normalizeRemotePath(path);
  const normalizedWorkspace = normalizeRemotePath(workspacePath);
  const windows = WINDOWS_ABSOLUTE_PATTERN.test(normalizedWorkspace);
  if (windows !== WINDOWS_ABSOLUTE_PATTERN.test(normalizedPath)) {
    return false;
  }
  const comparablePath = (windows
    ? normalizedPath.toLocaleLowerCase()
    : normalizedPath).replaceAll("\\", "/");
  const comparableWorkspace = (windows
    ? normalizedWorkspace.toLocaleLowerCase()
    : normalizedWorkspace).replaceAll("\\", "/");
  const prefix = comparableWorkspace.endsWith("/")
    ? comparableWorkspace
    : `${comparableWorkspace}/`;
  return comparablePath === comparableWorkspace ||
    comparablePath.startsWith(prefix);
}

async function replaceAsync(
  source: string,
  pattern: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
  const parts: string[] = [];
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index;
    parts.push(source.slice(offset, index));
    parts.push(await replacer(match));
    offset = index + match[0].length;
  }
  parts.push(source.slice(offset));
  return parts.join("");
}

function decodeUtf8(dataBase64: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    decodeBase64Bytes(dataBase64),
  );
}
