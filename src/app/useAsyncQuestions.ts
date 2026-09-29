import { useCallback, useEffect, useRef, useState } from "react";

import type { ServerId } from "../configuration";
import type { ConversationClient } from "../appServer";
import {
  asyncQuestionResponseStore,
  type AsyncQuestionResponse,
  type AsyncQuestionResponseStore,
} from "../transport/asyncQuestionResponses";
import type { ThreadTurn } from "./useServerThreads";

export interface AsyncQuestionView {
  readonly key: string;
  readonly title: string;
  readonly options: readonly string[] | null;
  readonly draft: string;
  readonly customAnswer: boolean;
  readonly status: "pending" | "sending" | "uncertain";
  readonly answer: string | null;
  readonly error: string | null;
}

interface QuestionState {
  readonly revision: number;
  readonly questions: ReadonlyMap<string, AsyncQuestionView>;
  readonly responses: ReadonlyMap<string, AsyncQuestionResponse>;
  readonly unsaved: ReadonlyMap<string, AsyncQuestionResponse>;
  readonly selectedKey: string | null;
  readonly expanded: boolean;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly loadError: string | null;
  readonly saveError: string | null;
}

interface UseAsyncQuestionsOptions {
  readonly client: Pick<ConversationClient, "subscribeNotifications"> | null;
  readonly serverId: ServerId | null;
  readonly threadId: string | null;
  readonly turns: readonly ThreadTurn[];
  readonly disabled: boolean;
  readonly sendAnswer: (answer: string) => Promise<boolean>;
  readonly store?: AsyncQuestionResponseStore;
}

function initialState(): QuestionState {
  return {
    revision: 0,
    questions: new Map(),
    responses: new Map(),
    unsaved: new Map(),
    selectedKey: null,
    expanded: true,
    loaded: false,
    loading: false,
    loadError: null,
    saveError: null,
  };
}

export function useAsyncQuestions({
  client,
  serverId,
  threadId,
  turns,
  disabled,
  sendAnswer,
  store = asyncQuestionResponseStore,
}: UseAsyncQuestionsOptions) {
  const scopeKey = serverId === null || threadId === null
    ? null
    : JSON.stringify([serverId, threadId]);
  const [states, setStates] = useState<ReadonlyMap<string, QuestionState>>(() => new Map());
  const statesRef = useRef(states);
  const sendingRef = useRef(new Set<string>());

  const update = useCallback((key: string, change: (state: QuestionState) => QuestionState) => {
    const previous = statesRef.current.get(key) ?? initialState();
    const next = change(previous);
    if (next === previous) return;
    const updated = new Map(statesRef.current).set(key, next);
    statesRef.current = updated;
    setStates(updated);
  }, []);

  useEffect(() => {
    if (client === null || serverId === null) return;
    return client.subscribeNotifications((notification) => {
      if (notification.method !== "thread/reverted") return;
      const key = JSON.stringify([serverId, notification.params.threadId]);
      if (!statesRef.current.has(key)) return;
      update(key, (state) => ({
        ...state,
        revision: state.revision + 1,
        questions: new Map(),
        selectedKey: null,
      }));
    });
  }, [client, serverId, update]);

  const load = useCallback(async (key: string, targetServerId: ServerId, targetThreadId: string) => {
    if (statesRef.current.get(key)?.loading) return;
    update(key, (state) => ({ ...state, loading: true, loadError: null }));
    try {
      const responses = await store.list(targetServerId, targetThreadId);
      update(key, (state) => ({
        ...state,
        responses: new Map([
          ...responses.map((response) => [response.questionKey, response] as const),
          ...state.responses,
        ]),
        loaded: true,
        loading: false,
        loadError: null,
      }));
    } catch {
      update(key, (state) => ({
        ...state,
        loading: false,
        loadError: "无法读取问题处理记录，请重试",
      }));
    }
  }, [store, update]);

  useEffect(() => {
    if (scopeKey === null || serverId === null || threadId === null) return;
    const hasQuestions = turns.some((turn) => turn.items.some((item) =>
      item.type === "agentMessage" && item.delivery === "async" && Boolean(item.questions?.length),
    ));
    if (!hasQuestions && !statesRef.current.get(scopeKey)?.questions.size) return;
    const state = statesRef.current.get(scopeKey);
    if (!state?.loaded && state?.loadError == null) {
      void load(scopeKey, serverId, threadId);
    }
  }, [load, scopeKey, serverId, threadId, turns]);

  useEffect(() => {
    if (scopeKey === null) return;
    update(scopeKey, (state) => {
      const questions = new Map(state.questions);
      let changed = false;
      for (const turn of turns) {
        for (const item of turn.items) {
          if (item.type !== "agentMessage" || item.delivery !== "async") continue;
          item.questions?.forEach((question, index) => {
            const key = JSON.stringify([turn.id, item.id, index]);
            const existing = questions.get(key);
            const options = question.options ?? null;
            if (existing?.title === question.title
              && JSON.stringify(existing.options) === JSON.stringify(options)) return;
            questions.set(key, {
              draft: "",
              customAnswer: false,
              status: "pending",
              answer: null,
              error: null,
              ...existing,
              key,
              title: question.title,
              options,
            });
            changed = true;
          });
        }
      }
      if (!changed) return state;
      const previouslyPending = [...state.questions.keys()].some((key) => !state.responses.has(key));
      const firstPending = [...questions.keys()].find((key) => !state.responses.has(key)) ?? null;
      return {
        ...state,
        questions,
        selectedKey: state.selectedKey ?? firstPending,
        expanded: previouslyPending ? state.expanded : true,
      };
    });
  }, [scopeKey, turns, update]);

  const save = useCallback(async (
    key: string,
    targetServerId: ServerId,
    targetThreadId: string,
    response: AsyncQuestionResponse,
  ) => {
    try {
      await store.record(targetServerId, targetThreadId, response);
      update(key, (state) => {
        const unsaved = new Map(state.unsaved);
        if (unsaved.get(response.questionKey) === response) unsaved.delete(response.questionKey);
        return { ...state, unsaved, saveError: unsaved.size === 0 ? null : state.saveError };
      });
    } catch {
      update(key, (state) => ({
        ...state,
        saveError: "问题处理记录未保存，重试只保存记录，不会再次发送回答",
      }));
    }
  }, [store, update]);

  const resolve = useCallback((key: string, response: AsyncQuestionResponse) => {
    update(key, (state) => ({
      ...state,
      responses: new Map(state.responses).set(response.questionKey, response),
      unsaved: new Map(state.unsaved).set(response.questionKey, response),
      selectedKey: state.selectedKey === response.questionKey ? null : state.selectedKey,
    }));
  }, [update]);

  const updateQuestion = useCallback((key: string, change: Partial<AsyncQuestionView>) => {
    if (scopeKey === null) return;
    update(scopeKey, (state) => {
      const question = state.questions.get(key);
      if (question === undefined) return state;
      return { ...state, questions: new Map(state.questions).set(key, { ...question, ...change }) };
    });
  }, [scopeKey, update]);

  const answer = useCallback(async (key: string, text: string) => {
    if (scopeKey === null || serverId === null || threadId === null || disabled
      || text.trim().length === 0 || sendingRef.current.has(scopeKey)) return;
    const state = statesRef.current.get(scopeKey);
    if (!state?.loaded || !state.questions.has(key) || state.responses.has(key)) return;
    sendingRef.current.add(scopeKey);
    updateQuestion(key, { status: "sending", answer: text, error: null });
    try {
      const accepted = await sendAnswer(text);
      if (statesRef.current.get(scopeKey)?.revision !== state.revision) return;
      if (!accepted) throw new Error("answer submission was not confirmed");
      const response: AsyncQuestionResponse = { questionKey: key, disposition: "sent" };
      resolve(scopeKey, response);
      void save(scopeKey, serverId, threadId, response);
    } catch {
      if (statesRef.current.get(scopeKey)?.revision !== state.revision) return;
      update(scopeKey, (current) => {
        const question = current.questions.get(key);
        if (question === undefined) return current;
        return {
          ...current,
          questions: new Map(current.questions).set(key, {
            ...question,
            status: "uncertain",
            error: "发送结果未确认，请检查聊天记录后再重试",
          }),
        };
      });
    } finally {
      sendingRef.current.delete(scopeKey);
    }
  }, [disabled, resolve, save, scopeKey, sendAnswer, serverId, threadId, update, updateQuestion]);

  const ignore = useCallback((key: string) => {
    if (scopeKey === null || serverId === null || threadId === null) return;
    const state = statesRef.current.get(scopeKey);
    const question = state?.questions.get(key);
    if (!state?.loaded || question === undefined || question.status === "sending"
      || state.responses.has(key)) return;
    const response: AsyncQuestionResponse = { questionKey: key, disposition: "ignored" };
    resolve(scopeKey, response);
    void save(scopeKey, serverId, threadId, response);
  }, [resolve, save, scopeKey, serverId, threadId]);

  const retry = useCallback(() => {
    if (scopeKey === null || serverId === null || threadId === null) return;
    const state = statesRef.current.get(scopeKey);
    if (!state?.loaded) {
      void load(scopeKey, serverId, threadId);
    } else {
      for (const response of state.unsaved.values()) {
        void save(scopeKey, serverId, threadId, response);
      }
    }
  }, [load, save, scopeKey, serverId, threadId]);

  const state = scopeKey === null ? undefined : states.get(scopeKey);
  const questions = state?.loaded
    ? [...state.questions.values()].filter(({ key }) => !state.responses.has(key))
    : [];
  const selectedKey = questions.find(({ key }) => key === state?.selectedKey)?.key
    ?? questions[0]?.key ?? null;

  return {
    questions,
    selectedKey,
    expanded: state?.expanded ?? true,
    error: state?.loadError ?? state?.saveError ?? null,
    answer,
    ignore,
    retry,
    setDraft: (key: string, draft: string) => updateQuestion(key, { draft }),
    setCustomAnswer: (key: string, customAnswer: boolean) => updateQuestion(key, { customAnswer }),
    setExpanded: (expanded: boolean) => {
      if (scopeKey !== null) update(scopeKey, (current) => ({ ...current, expanded }));
    },
    select: (selectedKey: string) => {
      if (scopeKey !== null) update(scopeKey, (current) => ({ ...current, selectedKey }));
    },
  };
}
