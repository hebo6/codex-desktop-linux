import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";

import { store } from "./store/store";
import { parseVisualRegressionQuery } from "./visual/visualRegressionQuery";
import "./styles/global.css";

const App = lazy(async () => ({ default: (await import("./App")).App }));
const VisualRegressionFixture = import.meta.env.DEV
  ? lazy(async () => ({
      default: (await import("./visual/VisualRegressionFixture")).VisualRegressionFixture,
    }))
  : null;
const ActivityScrollReproduction = import.meta.env.DEV
  ? lazy(async () => ({
      default: (await import("./visual/ActivityScrollReproduction")).ActivityScrollReproduction,
    }))
  : null;

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("缺少应用根节点");
}

const visualRegressionQuery = import.meta.env.DEV
  ? parseVisualRegressionQuery(window.location.search)
  : null;
const activityScrollReproduction = import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get("testFixture") ===
    "activity-scroll";

createRoot(rootElement).render(
  <StrictMode>
    <Provider store={store}>
      <Suspense fallback={<StartupShell />}>
        {activityScrollReproduction && ActivityScrollReproduction !== null
          ? <ActivityScrollReproduction />
          : visualRegressionQuery === null || VisualRegressionFixture === null
            ? <App />
            : <VisualRegressionFixture {...visualRegressionQuery} />}
      </Suspense>
    </Provider>
  </StrictMode>,
);

function StartupShell() {
  return (
    <div className="startup-shell" data-tauri-drag-region role="status">
      <aside aria-hidden="true">
        <strong>Codex</strong>
        <span />
        <span />
        <span />
      </aside>
      <main>
        <span className="startup-shell__spinner" />
        <strong>正在启动 Codex Desktop Linux</strong>
      </main>
    </div>
  );
}
