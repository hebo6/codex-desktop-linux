import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type { SavedPrompt, SavedPromptDraft } from "../transport/savedPrompts";
import { useModalLayer } from "./modalStack";
import styles from "./SavedPromptManagerDialog.module.css";

interface SavedPromptManagerDialogProps {
  readonly open: boolean;
  readonly startCreating?: boolean;
  readonly prompts: readonly SavedPrompt[];
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onReload: () => Promise<boolean>;
  readonly onCreate: (draft: SavedPromptDraft) => Promise<boolean>;
  readonly onUpdate: (prompt: SavedPrompt, draft: SavedPromptDraft) => Promise<boolean>;
  readonly onDelete: (prompt: SavedPrompt) => Promise<boolean>;
  readonly onReorder: (promptIds: readonly string[]) => Promise<boolean>;
  readonly onClearError: () => void;
}

type EditorState =
  | { readonly type: "create" }
  | { readonly type: "edit"; readonly prompt: SavedPrompt };

export function SavedPromptManagerDialog(props: SavedPromptManagerDialogProps) {
  if (!props.open) return null;
  return <SavedPromptManagerDialogContent {...props} />;
}

function SavedPromptManagerDialogContent({
  prompts,
  loading,
  saving,
  error,
  onClose,
  onReload,
  onCreate,
  onUpdate,
  onDelete,
  onReorder,
  onClearError,
  startCreating = false,
}: SavedPromptManagerDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const isTopmostModal = useModalLayer();
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(() =>
    startCreating ? { type: "create" } : null,
  );
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredPrompts = useMemo(() => normalizedQuery.length === 0
    ? prompts
    : prompts.filter((prompt) =>
      `${prompt.name}\n${prompt.content}`.toLocaleLowerCase().includes(normalizedQuery)),
  [normalizedQuery, prompts]);

  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (editor !== null) nameRef.current?.focus();
  }, [editor]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (saving) return;
        if (editor !== null) {
          setEditor(null);
          setFieldError(null);
          onClearError();
        } else {
          onClose();
        }
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
      } else if (!dialogRef.current?.contains(document.activeElement)) {
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
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [editor, isTopmostModal, onClearError, onClose, saving]);

  const close = () => {
    if (!saving) onClose();
  };

  const beginCreate = () => {
    setEditor({ type: "create" });
    setName("");
    setContent("");
    setFieldError(null);
    onClearError();
  };

  const beginEdit = (prompt: SavedPrompt) => {
    setEditor({ type: "edit", prompt });
    setName(prompt.name);
    setContent(prompt.content);
    setFieldError(null);
    onClearError();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (editor === null || saving) return;
    const draft = validateDraft(name, content);
    if (typeof draft === "string") {
      setFieldError(draft);
      return;
    }
    const saved = editor.type === "create"
      ? await onCreate(draft)
      : await onUpdate(editor.prompt, draft);
    if (saved) {
      setEditor(null);
      setFieldError(null);
    }
  };

  const move = async (promptId: string, offset: -1 | 1) => {
    const index = prompts.findIndex((prompt) => prompt.promptId === promptId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= prompts.length || saving) return;
    const next = prompts.map((prompt) => prompt.promptId);
    [next[index], next[target]] = [next[target]!, next[index]!];
    await onReorder(next);
  };

  return (
    <div className={styles.backdrop} onClick={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <section
        aria-busy={saving || loading || undefined}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.dialog}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className={styles.header}>
          <div>
            <h2 id={titleId}>{editor === null ? "管理常用提示词" : editor.type === "create" ? "新建常用提示词" : "编辑常用提示词"}</h2>
            <p id={descriptionId}>{editor === null ? "所有服务器、项目和应用窗口共享" : "点击提示词时将立即发送这里保存的完整内容"}</p>
          </div>
          <button aria-label="关闭常用提示词管理" className={styles.closeButton} disabled={saving} onClick={close} ref={closeRef} type="button">×</button>
        </header>

        {editor === null ? (
          <div className={styles.managerBody}>
            <div className={styles.toolbar}>
              <input
                aria-label="搜索常用提示词"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称或内容"
                type="search"
                value={query}
              />
              <button className={styles.primaryButton} disabled={saving} onClick={beginCreate} type="button">新建提示词</button>
            </div>
            {normalizedQuery.length === 0 ? null : <p className={styles.sortNotice}>清除搜索后可以调整全局顺序</p>}
            {error === null ? null : <div className={styles.error} role="alert">{error}<button disabled={loading} onClick={() => void onReload()} type="button">重新加载</button></div>}
            <div aria-live="polite" className={styles.list}>
              {loading && prompts.length === 0 ? <p className={styles.empty}>正在加载常用提示词</p> : null}
              {!loading && filteredPrompts.length === 0 ? (
                <div className={styles.empty}>
                  <strong>{prompts.length === 0 ? "还没有常用提示词" : "没有匹配的常用提示词"}</strong>
                  <span>{prompts.length === 0 ? "新建后即可从问题输入框直接发送" : "尝试使用其他搜索词"}</span>
                </div>
              ) : null}
              {filteredPrompts.map((prompt) => {
                const index = prompts.findIndex(({ promptId }) => promptId === prompt.promptId);
                const confirming = confirmingDeleteId === prompt.promptId;
                return (
                  <article key={prompt.promptId}>
                    <div className={styles.promptText}>
                      <strong>{prompt.name}</strong>
                      <p>{prompt.content}</p>
                    </div>
                    <div className={styles.rowActions}>
                      {confirming ? (
                        <>
                          <button disabled={saving} onClick={() => setConfirmingDeleteId(null)} type="button">取消</button>
                          <button className={styles.dangerButton} disabled={saving} onClick={async () => {
                            if (await onDelete(prompt)) setConfirmingDeleteId(null);
                          }} type="button">确认删除</button>
                        </>
                      ) : (
                        <>
                          <button aria-label={`上移 ${prompt.name}`} disabled={saving || normalizedQuery.length > 0 || index === 0} onClick={() => void move(prompt.promptId, -1)} title={normalizedQuery.length > 0 ? "清除搜索后可以排序" : "上移"} type="button">↑</button>
                          <button aria-label={`下移 ${prompt.name}`} disabled={saving || normalizedQuery.length > 0 || index === prompts.length - 1} onClick={() => void move(prompt.promptId, 1)} title={normalizedQuery.length > 0 ? "清除搜索后可以排序" : "下移"} type="button">↓</button>
                          <button disabled={saving} onClick={() => beginEdit(prompt)} type="button">编辑</button>
                          <button className={styles.dangerText} disabled={saving} onClick={() => setConfirmingDeleteId(prompt.promptId)} type="button">删除</button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        ) : (
          <form className={styles.editor} onSubmit={(event) => void submit(event)}>
            <div className={styles.fields}>
              <label>
                <span>名称</span>
                <input
                  aria-invalid={fieldError !== null || undefined}
                  disabled={saving}
                  maxLength={80}
                  onChange={(event) => {
                    setName(event.target.value);
                    setFieldError(null);
                  }}
                  placeholder="例如：审查当前修改"
                  ref={nameRef}
                  value={name}
                />
              </label>
              <label>
                <span>提示词内容</span>
                <textarea
                  aria-invalid={fieldError !== null || undefined}
                  disabled={saving}
                  maxLength={32_000}
                  onChange={(event) => {
                    setContent(event.target.value);
                    setFieldError(null);
                  }}
                  placeholder="输入点击后要立即发送的完整提示词"
                  rows={10}
                  value={content}
                />
              </label>
              <small>{[...content].length} / 32000 个字符</small>
              {fieldError === null ? null : <div className={styles.error} role="alert">{fieldError}</div>}
              {error === null ? null : <div className={styles.error} role="alert">{error}</div>}
            </div>
            <footer className={styles.editorActions}>
              <button disabled={saving} onClick={() => {
                setEditor(null);
                setFieldError(null);
                onClearError();
              }} type="button">取消</button>
              <button className={styles.primaryButton} disabled={saving} type="submit">{saving ? "正在保存" : "保存"}</button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}

function validateDraft(name: string, content: string): SavedPromptDraft | string {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) return "请输入名称";
  if ([...trimmedName].length > 80) return "名称不能超过 80 个字符";
  if (content.trim().length === 0) return "请输入提示词内容";
  if ([...content].length > 32_000) return "提示词内容不能超过 32000 个字符";
  return { name: trimmedName, content };
}
