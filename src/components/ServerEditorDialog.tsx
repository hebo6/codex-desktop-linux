import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type { ProxyProfile, ServerId } from "../configuration";
import {
  FieldError,
  type ServerEditorFieldSupport,
} from "./ServerEditorFields";
import { ServerEditorLocalFields } from "./ServerEditorLocalFields";
import { ServerEditorRemoteFields } from "./ServerEditorRemoteFields";
import { useModalLayer } from "./modalStack";
import {
  buildServerEditorSubmission,
  createServerEditorDraft,
  existingServerCredentialType,
  formErrorFromUnknown,
  type LocalDraft,
  type RemoteDraft,
  type ServerEditorDraft,
  type ServerEditorFieldErrors,
  type ServerEditorFieldName,
  type ServerEditorMode,
  type ServerEditorSubmission,
  type ServerEditorTestState,
  type ServerType,
} from "./serverEditorModel";
import styles from "./ServerEditorDialog.module.css";

export type {
  ServerCredentialIntent,
  ServerEditorMode,
  ServerEditorSubmission,
  ServerEditorTestState,
} from "./serverEditorModel";

export interface ServerEditorDialogProps {
  readonly open: boolean;
  readonly editorSessionId: string;
  readonly createdProfileContinuationId?: ServerId;
  readonly mode: ServerEditorMode;
  readonly proxies: readonly ProxyProfile[];
  readonly saving: boolean;
  readonly error?: string;
  readonly testState?: ServerEditorTestState;
  readonly onCancel: () => void;
  readonly onSubmit: (submission: ServerEditorSubmission) => void;
  readonly onTest?: (submission: ServerEditorSubmission) => void;
  readonly onCancelTest?: () => void;
  readonly onCreateProxy?: () => void;
}

function credentialLabel(type: "sensitiveEnvironment" | "bearerToken"): string {
  return type === "sensitiveEnvironment" ? "敏感环境变量" : "Bearer 令牌";
}

export function ServerEditorDialog(props: ServerEditorDialogProps) {
  if (!props.open) {
    return null;
  }
  const targetKey =
    props.mode.type === "create" ||
    props.mode.profile.serverId === props.createdProfileContinuationId
      ? "create"
      : props.mode.profile.serverId;
  return (
    <ServerEditorDialogContent
      key={JSON.stringify([props.editorSessionId, targetKey])}
      {...props}
    />
  );
}

function ServerEditorDialogContent({
  mode,
  proxies,
  saving,
  error,
  testState,
  onCancel,
  onSubmit,
  onTest,
  onCancelTest,
  onCreateProxy,
}: ServerEditorDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const fieldIdPrefix = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const isTopmostModal = useModalLayer();
  const typeRefs = useRef<Partial<Record<ServerType, HTMLInputElement>>>({});
  const fieldRefs = useRef<Partial<Record<ServerEditorFieldName, HTMLElement>>>(
    {},
  );
  const [draft, setDraft] = useState<ServerEditorDraft>(() =>
    createServerEditorDraft(mode),
  );
  const [testResultStale, setTestResultStale] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<ServerEditorFieldErrors>({});
  const [pendingFocus, setPendingFocus] = useState<ServerEditorFieldName>();
  const savedCredentialType = existingServerCredentialType(mode);
  const availableProxyIds = useMemo(
    () => new Set(proxies.map(({ proxyId }) => proxyId)),
    [proxies],
  );
  const testActions =
    onTest === undefined || onCancelTest === undefined
      ? undefined
      : { cancel: onCancelTest, start: onTest };
  const testingEnabled = testActions !== undefined;
  const cancelFailed = testingEnabled && testState?.type === "cancelFailed";
  const testInProgress =
    testingEnabled &&
    (testState?.type === "testing" ||
      testState?.type === "cancelling" ||
      cancelFailed);
  const cancellingTest = testingEnabled && testState?.type === "cancelling";
  const displayedTestState = testResultStale ? undefined : testState;

  const updateDraft = useCallback(
    (update: (current: ServerEditorDraft) => ServerEditorDraft) => {
      setDraft(update);
      setTestResultStale(true);
    },
    [],
  );

  useEffect(() => {
    setTestResultStale(false);
  }, [testState]);

  const fieldId = useCallback(
    (field: ServerEditorFieldName) => `${fieldIdPrefix}-${field}`,
    [fieldIdPrefix],
  );
  const errorId = useCallback(
    (field: ServerEditorFieldName) => `${fieldId(field)}-error`,
    [fieldId],
  );
  const clearFieldError = useCallback((field: ServerEditorFieldName) => {
    setFieldErrors((current) => {
      if (current[field] === undefined) {
        return current;
      }
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);
  const registerField = useCallback(
    (field: ServerEditorFieldName) => (element: HTMLElement | null) => {
      if (element === null) {
        delete fieldRefs.current[field];
      } else {
        fieldRefs.current[field] = element;
      }
    },
    [],
  );
  const support: ServerEditorFieldSupport = useMemo(
    () => ({
      fieldErrors,
      fieldId,
      errorId,
      clearFieldError,
      registerField,
    }),
    [clearFieldError, errorId, fieldErrors, fieldId, registerField],
  );

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    typeRefs.current[draft.serverType]?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  useEffect(() => {
    if (pendingFocus === undefined) {
      return;
    }
    const credentialFallback =
      draft.serverType === "localStdio"
        ? fieldRefs.current.sensitiveEnvironment
        : draft.remote.authentication === "bearer"
          ? fieldRefs.current.bearerToken
          : fieldRefs.current.authentication;
    const target =
      pendingFocus === "serverType"
        ? typeRefs.current[draft.serverType]
        : pendingFocus === "credential"
          ? (fieldRefs.current.credential ?? credentialFallback)
          : fieldRefs.current[pendingFocus];
    target?.focus();
    setPendingFocus(undefined);
  }, [draft.serverType, fieldErrors, pendingFocus]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal()) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (!saving && !cancelFailed) {
          onCancel();
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const panel = panelRef.current;
      if (panel === null) {
        return;
      }
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
      } else if (!panel.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cancelFailed, isTopmostModal, onCancel, saving]);

  const updateLocal = (patch: Partial<LocalDraft>) => {
    updateDraft((current) => ({
      ...current,
      local: { ...current.local, ...patch },
    }));
  };
  const updateRemote = (patch: Partial<RemoteDraft>) => {
    updateDraft((current) => ({
      ...current,
      remote: { ...current.remote, ...patch },
    }));
  };
  const cancelCredentialClear = () => {
    updateDraft((current) => ({
      ...current,
      clearExistingCredential: false,
    }));
  };
  const clearCredential = () => {
    updateDraft((current) => ({
      ...current,
      clearExistingCredential: true,
      local: { ...current.local, sensitiveEnvironment: [] },
      remote: { ...current.remote, bearerToken: "" },
    }));
    clearFieldError("credential");
    clearFieldError("sensitiveEnvironment");
    clearFieldError("bearerToken");
  };

  const buildSubmission = (): ServerEditorSubmission | undefined => {
    setFieldErrors({});
    try {
      return buildServerEditorSubmission({ mode, draft, availableProxyIds });
    } catch (caught) {
      const formError = formErrorFromUnknown(caught);
      setFieldErrors({ [formError.field]: formError.message });
      setPendingFocus(formError.field);
      return undefined;
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || testInProgress) {
      return;
    }
    const submission = buildSubmission();
    if (submission !== undefined) {
      onSubmit(submission);
    }
  };
  const handleTest = () => {
    if (testActions === undefined || saving || cancellingTest || cancelFailed) {
      return;
    }
    if (testState?.type === "testing") {
      testActions.cancel();
      return;
    }
    const submission = buildSubmission();
    if (submission !== undefined) {
      testActions.start(submission);
    }
  };

  const credentialStatus =
    savedCredentialType === undefined ? null : (
      <div
        className={styles.credentialStatus}
        data-clearing={draft.clearExistingCredential}
      >
        <span>
          {draft.clearExistingCredential
            ? `保存时将清除已保存的 ${credentialLabel(savedCredentialType)}`
            : `已保存的 ${credentialLabel(savedCredentialType)}，身份范围不变时留空可保持`}
        </span>
        <button
          className={styles.textButton}
          onClick={() => {
            if (draft.clearExistingCredential) {
              cancelCredentialClear();
            } else {
              clearCredential();
            }
          }}
          ref={registerField("credential")}
          type="button"
        >
          {draft.clearExistingCredential ? "撤销清除" : "清除已保存凭据"}
        </button>
      </div>
    );
  const title = mode.type === "create" ? "新建服务器" : "编辑服务器";

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving && !cancelFailed) {
          onCancel();
        }
      }}
    >
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.dialog}
        ref={panelRef}
        role="dialog"
      >
        <header className={styles.header}>
          <div>
            <h2 id={titleId}>{title}</h2>
            <p id={descriptionId}>配置 app-server 的连接方式与凭据</p>
          </div>
          <button
            aria-label="关闭服务器编辑器"
            className={styles.closeButton}
            disabled={saving || cancelFailed}
            onClick={onCancel}
            title="关闭服务器编辑器"
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <form className={styles.form} onSubmit={handleSubmit}>
          <fieldset
            className={styles.disabledGroup}
            disabled={saving || testInProgress}
          >
            <div className={styles.body}>
              <fieldset
                aria-describedby={
                  fieldErrors.serverType === undefined
                    ? undefined
                    : errorId("serverType")
                }
                className={styles.typeChooser}
              >
                <legend>连接类型</legend>
                {(["localStdio", "remoteWebSocket"] as const).map((type) => (
                  <label key={type}>
                    <input
                      checked={draft.serverType === type}
                      name={`${fieldIdPrefix}-server-type`}
                      onChange={() => {
                        updateDraft((current) => ({
                          ...current,
                          serverType: type,
                        }));
                        clearFieldError("serverType");
                        clearFieldError("credential");
                      }}
                      ref={(element) => {
                        if (element === null) {
                          delete typeRefs.current[type];
                        } else {
                          typeRefs.current[type] = element;
                        }
                      }}
                      type="radio"
                    />
                    <span>
                      <strong>
                        {type === "localStdio"
                          ? "本机 stdio"
                          : "远程 WebSocket"}
                      </strong>
                      <small>
                        {type === "localStdio"
                          ? "启动本机可执行文件"
                          : "连接 ws:// 或 wss:// 地址"}
                      </small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <FieldError
                id={errorId("serverType")}
                message={fieldErrors.serverType}
              />

              <label className={styles.field} htmlFor={fieldId("name")}>
                <span>名称</span>
                <input
                  aria-describedby={
                    fieldErrors.name === undefined ? undefined : errorId("name")
                  }
                  aria-invalid={fieldErrors.name !== undefined}
                  id={fieldId("name")}
                  onChange={(event) => {
                    updateDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }));
                    clearFieldError("name");
                  }}
                  placeholder="例如：本机 Codex"
                  ref={registerField("name")}
                  value={draft.name}
                />
                <FieldError id={errorId("name")} message={fieldErrors.name} />
              </label>

              {draft.serverType === "localStdio" ? (
                <ServerEditorLocalFields
                  credentialStatus={credentialStatus}
                  draft={draft.local}
                  onChange={updateLocal}
                  onSensitiveInput={cancelCredentialClear}
                  support={support}
                />
              ) : (
                <ServerEditorRemoteFields
                  credentialStatus={credentialStatus}
                  draft={draft.remote}
                  onBearerInput={cancelCredentialClear}
                  onChange={updateRemote}
                  {...(onCreateProxy === undefined ? {} : { onCreateProxy })}
                  proxies={proxies}
                  support={support}
                />
              )}

              {error === undefined ? null : (
                <div className={styles.submitError} role="alert">
                  {error}
                </div>
              )}
              {!testingEnabled || displayedTestState === undefined ? null : (
                <div
                  className={styles.testStatus}
                  data-status={displayedTestState.type}
                  role={
                    displayedTestState.type === "failed" ||
                    displayedTestState.type === "cancelFailed"
                      ? "alert"
                      : "status"
                  }
                >
                  {displayedTestState.type === "testing"
                    ? "正在测试连接…"
                    : displayedTestState.type === "cancelling"
                      ? "正在取消测试连接…"
                      : displayedTestState.type === "succeeded"
                        ? (displayedTestState.message ?? "测试连接成功")
                        : displayedTestState.message}
                </div>
              )}
            </div>
          </fieldset>

          <footer className={styles.footer}>
            <button
              className={styles.secondaryButton}
              disabled={saving || cancelFailed}
              onClick={onCancel}
              type="button"
            >
              取消
            </button>
            {!testingEnabled ? null : (
              <button
                className={styles.secondaryButton}
                disabled={saving || cancellingTest || cancelFailed}
                onClick={handleTest}
                type="button"
              >
                {cancellingTest
                  ? "正在取消…"
                  : cancelFailed
                    ? "清理失败"
                    : testState?.type === "testing"
                      ? "取消测试"
                      : "测试连接"}
              </button>
            )}
            <button
              className={styles.primaryButton}
              disabled={saving || testInProgress}
              type="submit"
            >
              {saving ? "正在保存…" : "保存"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
