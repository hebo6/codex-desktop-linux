import { createRoot } from "react-dom/client";

import { ApplicationRoot } from "./ApplicationRoot";
import { parseVisualRegressionQuery } from "./visual/visualRegressionQuery";
import "./styles/global.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("缺少应用根节点");
}

const visualRegressionQuery = import.meta.env.DEV
  ? parseVisualRegressionQuery(window.location.search)
  : null;
const protocolDebug =
  new URLSearchParams(window.location.search).get("view") === "protocol-debug";

void renderApplication(rootElement);

async function renderApplication(container: HTMLElement) {
  if (visualRegressionQuery !== null) {
    const { installVisualTauriMocks } = await import("./visual/installVisualTauriMocks");
    installVisualTauriMocks();
  }

  createRoot(container).render(
    <ApplicationRoot
      protocolDebug={protocolDebug}
      visualRegressionQuery={visualRegressionQuery}
    />,
  );
}
