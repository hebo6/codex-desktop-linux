import { useCallback, useEffect, useRef, useState } from "react";

import {
  SavedPromptCommandError,
  savedPromptStore as defaultSavedPromptStore,
  type SavedPrompt,
  type SavedPromptDraft,
  type SavedPromptStore,
} from "../transport/savedPrompts";

export interface SavedPromptsController {
  readonly prompts: readonly SavedPrompt[];
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly reload: () => Promise<boolean>;
  readonly create: (draft: SavedPromptDraft) => Promise<boolean>;
  readonly update: (prompt: SavedPrompt, draft: SavedPromptDraft) => Promise<boolean>;
  readonly remove: (prompt: SavedPrompt) => Promise<boolean>;
  readonly reorder: (promptIds: readonly string[]) => Promise<boolean>;
  readonly clearError: () => void;
}

export function useSavedPrompts(
  store: SavedPromptStore = defaultSavedPromptStore,
): SavedPromptsController {
  const [prompts, setPrompts] = useState<readonly SavedPrompt[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activated, setActivated] = useState(false);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const reload = useCallback(async (): Promise<boolean> => {
    setActivated(true);
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const loaded = await store.list();
      if (!mountedRef.current || requestRef.current !== request) return false;
      setPrompts(loaded);
      setError(null);
      return true;
    } catch (loadError) {
      if (!mountedRef.current || requestRef.current !== request) return false;
      setError(messageForError(loadError, "无法加载常用提示词"));
      return false;
    } finally {
      if (mountedRef.current && requestRef.current === request) setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    if (!activated || store.subscribe === undefined) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void store.subscribe(() => void reload()).then(
      (release) => {
        if (disposed) release();
        else unsubscribe = release;
      },
      () => undefined,
    );
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [activated, reload, store]);

  const runMutation = useCallback(async (
    operation: () => Promise<unknown>,
  ): Promise<boolean> => {
    if (saving) return false;
    setSaving(true);
    setError(null);
    try {
      await operation();
      await reload();
      return true;
    } catch (mutationError) {
      if (mountedRef.current) {
        setError(messageForError(mutationError, "无法保存常用提示词"));
        setLoading(false);
      }
      return false;
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [reload, saving]);

  return {
    prompts,
    loading,
    saving,
    error,
    reload,
    create: (draft) => runMutation(() => store.create(draft)),
    update: (prompt, draft) => runMutation(() => store.update(prompt, draft)),
    remove: (prompt) => runMutation(() => store.delete(prompt)),
    reorder: (promptIds) => runMutation(() => store.reorder(promptIds)),
    clearError: () => setError(null),
  };
}

function messageForError(error: unknown, fallback: string): string {
  if (!(error instanceof SavedPromptCommandError)) return fallback;
  switch (error.code) {
    case "nameConflict":
      return "已有同名常用提示词，请使用其他名称";
    case "notFound":
      return "该常用提示词已被删除，请重新选择";
    case "versionConflict":
      return "该常用提示词已在其他窗口中修改，请重新编辑";
    case "collectionConflict":
      return "常用提示词列表已在其他窗口中变化，请重新排序";
    case "invalidRequest":
      return "名称或提示词内容不符合要求";
    case "storageUnavailable":
      return fallback;
  }
}
