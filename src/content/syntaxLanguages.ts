export type SyntaxLanguage =
  | "bash"
  | "c"
  | "cmake"
  | "cpp"
  | "css"
  | "dockerfile"
  | "go"
  | "html"
  | "java"
  | "javascript"
  | "json"
  | "jsonc"
  | "jsx"
  | "kotlin"
  | "makefile"
  | "markdown"
  | "mdx"
  | "python"
  | "ruby"
  | "rust"
  | "sql"
  | "swift"
  | "toml"
  | "tsx"
  | "typescript"
  | "xml"
  | "yaml";

export interface SourceLanguage {
  readonly id: SyntaxLanguage;
  readonly label: string;
}

const LANGUAGES_BY_EXTENSION: Readonly<Record<string, SourceLanguage | undefined>> = {
  bash: { id: "bash", label: "Shell" },
  c: { id: "c", label: "C" },
  cc: { id: "cpp", label: "C++" },
  cmake: { id: "cmake", label: "CMake" },
  cpp: { id: "cpp", label: "C++" },
  css: { id: "css", label: "CSS" },
  cts: { id: "typescript", label: "TypeScript" },
  cxx: { id: "cpp", label: "C++" },
  dockerfile: { id: "dockerfile", label: "Dockerfile" },
  go: { id: "go", label: "Go" },
  h: { id: "c", label: "C/C++" },
  hh: { id: "cpp", label: "C++" },
  hpp: { id: "cpp", label: "C++" },
  htm: { id: "html", label: "HTML" },
  html: { id: "html", label: "HTML" },
  hxx: { id: "cpp", label: "C++" },
  java: { id: "java", label: "Java" },
  js: { id: "javascript", label: "JavaScript" },
  json: { id: "json", label: "JSON" },
  jsonc: { id: "jsonc", label: "JSONC" },
  jsx: { id: "jsx", label: "JavaScript JSX" },
  kt: { id: "kotlin", label: "Kotlin" },
  kts: { id: "kotlin", label: "Kotlin" },
  markdown: { id: "markdown", label: "Markdown" },
  md: { id: "markdown", label: "Markdown" },
  mdx: { id: "mdx", label: "MDX" },
  mjs: { id: "javascript", label: "JavaScript" },
  mk: { id: "makefile", label: "Makefile" },
  mts: { id: "typescript", label: "TypeScript" },
  py: { id: "python", label: "Python" },
  pyw: { id: "python", label: "Python" },
  rb: { id: "ruby", label: "Ruby" },
  rs: { id: "rust", label: "Rust" },
  sh: { id: "bash", label: "Shell" },
  sql: { id: "sql", label: "SQL" },
  swift: { id: "swift", label: "Swift" },
  toml: { id: "toml", label: "TOML" },
  ts: { id: "typescript", label: "TypeScript" },
  tsx: { id: "tsx", label: "TypeScript JSX" },
  xml: { id: "xml", label: "XML" },
  xsd: { id: "xml", label: "XML Schema" },
  xsl: { id: "xml", label: "XSLT" },
  yaml: { id: "yaml", label: "YAML" },
  yml: { id: "yaml", label: "YAML" },
};

const LANGUAGES_BY_FILE_NAME: Readonly<Record<string, SourceLanguage | undefined>> = {
  ".bash_profile": { id: "bash", label: "Shell" },
  ".bashrc": { id: "bash", label: "Shell" },
  "cmakelists.txt": { id: "cmake", label: "CMake" },
  "dockerfile": { id: "dockerfile", label: "Dockerfile" },
  "gnumakefile": { id: "makefile", label: "Makefile" },
  "makefile": { id: "makefile", label: "Makefile" },
};

export function sourceLanguageForPath(path: string): SourceLanguage | null {
  const name = path.split(/[\\/]/u).at(-1)?.toLocaleLowerCase() ?? "";
  const namedLanguage = LANGUAGES_BY_FILE_NAME[name];
  if (namedLanguage !== undefined) return namedLanguage;
  const extension = name.split(".").at(-1) ?? "";
  return LANGUAGES_BY_EXTENSION[extension] ?? null;
}
