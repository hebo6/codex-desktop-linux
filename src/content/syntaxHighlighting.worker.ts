import {
  createBundledHighlighter,
  createSingletonShorthands,
} from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";

import type { SyntaxLanguage } from "./syntaxLanguages";

const bundledLanguages = {
  bash: () => import("@shikijs/langs/bash"),
  c: () => import("@shikijs/langs/c"),
  cmake: () => import("@shikijs/langs/cmake"),
  cpp: () => import("@shikijs/langs/cpp"),
  css: () => import("@shikijs/langs/css"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  go: () => import("@shikijs/langs/go"),
  html: () => import("@shikijs/langs/html"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  makefile: () => import("@shikijs/langs/makefile"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
} satisfies Record<SyntaxLanguage, () => Promise<unknown>>;

const bundledThemes = {
  "github-dark": () => import("@shikijs/themes/github-dark"),
  "github-light": () => import("@shikijs/themes/github-light"),
};

const createHighlighter = createBundledHighlighter<
  SyntaxLanguage,
  keyof typeof bundledThemes
>({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: () => createJavaScriptRegexEngine(),
});

const { codeToTokens } = createSingletonShorthands(createHighlighter);

interface SyntaxWorkerRequest {
  readonly id: number;
  readonly language: SyntaxLanguage;
  readonly source: string;
}

interface WorkerScope {
  onmessage:
    | ((event: MessageEvent<SyntaxWorkerRequest>) => void)
    | null;
  postMessage(message: unknown): void;
}

const workerScope = globalThis as unknown as WorkerScope;

workerScope.onmessage = ({ data }) => {
  void codeToTokens(data.source, {
    defaultColor: false,
    lang: data.language,
    themes: {
      dark: "github-dark",
      light: "github-light",
    },
    tokenizeMaxLineLength: 20_000,
  }).then(
    ({ tokens }) => {
      workerScope.postMessage({
        id: data.id,
        lines: tokens.map((line) =>
          line.map(({ content, htmlStyle }) => ({
            content,
            style: htmlStyle ?? {},
          })),
        ),
        ok: true,
      });
    },
    () => {
      workerScope.postMessage({ id: data.id, ok: false });
    },
  );
};
