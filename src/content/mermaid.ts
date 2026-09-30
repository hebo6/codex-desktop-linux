import type { MermaidConfig } from "mermaid";

import type { ColorScheme } from "./useColorScheme";
import styles from "./mermaid.module.css";

const MAX_SOURCE_LENGTH = 50_000;
let renderQueue: Promise<void> = Promise.resolve();

export function renderMermaid(source: string, theme: ColorScheme): Promise<string> {
  if (source.trim().length === 0) return Promise.reject(new Error("Mermaid 源码为空"));
  if (source.length > MAX_SOURCE_LENGTH) {
    return Promise.reject(new Error("图表源码超过 50,000 字符限制"));
  }
  // initialize 修改 Mermaid 的全局配置，必须与对应 render 作为一个任务排队
  const result = renderQueue.then(() => renderDiagram(source, theme));
  // 一张图的语法错误不应阻塞后续图表，错误仍由 result 交给调用者
  renderQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function renderDiagram(source: string, theme: ColorScheme): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  const config: MermaidConfig = {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    maxTextSize: MAX_SOURCE_LENGTH,
    maxEdges: 500,
    theme: theme === "dark" ? "dark" : "default",
    darkMode: theme === "dark",
    themeCSS: "",
    themeVariables: {},
    fontFamily: "system-ui, sans-serif",
    altFontFamily: "system-ui, sans-serif",
    dompurifyConfig: { FORBID_TAGS: ["style"], FORBID_ATTR: ["style"] },
  };
  // 应用决定安全边界和主题，frontmatter / init 指令只能修改图表布局等选项
  mermaid.initialize({ ...config, secure: ["secure", ...Object.keys(config)] });

  const container = document.createElement("div");
  container.className = styles.staging!;
  container.setAttribute("aria-hidden", "true");
  container.inert = true;
  document.body.append(container);
  try {
    const { svg } = await mermaid.render(`mermaid-${crypto.randomUUID()}`, source, container);
    return svg;
  } finally {
    container.remove();
  }
}
