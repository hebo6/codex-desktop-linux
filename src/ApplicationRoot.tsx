import { lazy, StrictMode, Suspense } from "react";
import { Provider } from "react-redux";

import { ApplicationContextMenus } from "./components/ApplicationContextMenus";
import { ApplicationShortcuts } from "./components/ApplicationShortcuts";
import { store } from "./store/store";
import type { VisualRegressionQuery } from "./visual/visualRegressionQuery";

const App = lazy(async () => ({ default: (await import("./App")).App }));
const ProtocolDebugView = lazy(async () => ({
  default: (await import("./protocolDebug/ProtocolDebugView"))
    .ProtocolDebugView,
}));
const VisualRegressionFixture = import.meta.env.DEV
  ? lazy(async () => ({
      default: (await import("./visual/VisualRegressionFixture")).VisualRegressionFixture,
    }))
  : null;

interface ApplicationRootProps {
  readonly protocolDebug: boolean;
  readonly visualRegressionQuery: VisualRegressionQuery | null;
}

export function ApplicationRoot({
  protocolDebug,
  visualRegressionQuery,
}: ApplicationRootProps) {
  return (
    <StrictMode>
      <ApplicationContextMenus />
      <ApplicationShortcuts />
      <Suspense fallback={<StartupShell />}>
        {protocolDebug
          ? <ProtocolDebugView />
          : (
            <Provider store={store}>
              {visualRegressionQuery === null || VisualRegressionFixture === null
                ? <App />
                : <VisualRegressionFixture {...visualRegressionQuery} />}
            </Provider>
          )}
      </Suspense>
    </StrictMode>
  );
}

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
