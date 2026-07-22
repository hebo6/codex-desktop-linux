import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import type { ConversationTurnConfiguration } from "../app/useConversation";
import type { ComposerMentionReference } from "../app/useComposerCapabilities";
import { useSavedPrompts } from "../app/useSavedPrompts";
import { sanitizeSvg } from "../content/sanitizeSvg";
import {
  browserBlobUrls,
  useBlobUrl,
  type BlobUrlFactory,
} from "../content/useBlobUrl";
import type { FuzzyFileSearchResult } from "../protocol/generated/types/FuzzyFileSearchResponse";
import type { Model } from "../protocol/generated/types/ModelListResponse";
import type { PermissionProfileSummary } from "../protocol/generated/types/PermissionProfileListResponse";
import type { SkillMetadata } from "../protocol/generated/types/SkillsListResponse";
import type { TurnStartParams } from "../protocol/generated";
import { draftStore as persistentDraftStore, type DraftStore } from "../transport/drafts";
import {
  savedPromptStore as persistentSavedPromptStore,
  type SavedPrompt,
  type SavedPromptStore,
} from "../transport/savedPrompts";
import { SavedPromptManagerDialog } from "./SavedPromptManagerDialog";
import styles from "./Composer.module.css";

type StructuredInput = Extract<
  TurnStartParams["input"][number],
  { type: "skill" | "mention" }
>;
type MenuKind = "/" | "$" | "@";

interface Trigger {
  readonly kind: MenuKind;
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

interface Suggestion {
  readonly id: string;
  readonly kind: "command" | "skill" | "file" | "app" | "plugin" | "notice";
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly disabled?: boolean;
  readonly disabledReason?: string | undefined;
  readonly value?: SkillMetadata | FuzzyFileSearchResult | SlashCommand | ComposerMentionReference;
}

interface SlashCommand {
  readonly name: string;
  readonly description: string;
  readonly behavior: "compact" | "review" | "insert" | "attach" | "settings" | "unavailable";
  readonly unavailableReason?: string;
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "review", description: "审查当前工作区的未提交修改", behavior: "review" },
  { name: "compact", description: "压缩当前会话上下文", behavior: "compact" },
  { name: "continue", description: "继续最近可继续的任务", behavior: "unavailable", unavailableReason: "请从最近会话列表选择要继续的任务" },
  { name: "goal", description: "创建或查看目标流程", behavior: "insert" },
  { name: "init", description: "初始化项目指导文件", behavior: "insert" },
  { name: "mcp", description: "查看 MCP 工具和资源", behavior: "insert" },
  { name: "plan", description: "请求计划模式", behavior: "insert" },
  { name: "settings", description: "打开客户端设置", behavior: "settings" },
  { name: "feedback", description: "打开反馈入口", behavior: "unavailable", unavailableReason: "当前版本未配置反馈地址" },
  { name: "attach", description: "选择并附加图片", behavior: "attach" },
];

interface DraftAttachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly blob: Blob | null;
  readonly error: string | null;
}

const MAX_IMAGE_SIZE = 16 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
] as const);
const SUPPORTED_IMAGE_TYPE_SET: ReadonlySet<string> = new Set(SUPPORTED_IMAGE_TYPES);
const IMAGE_ACCEPT = SUPPORTED_IMAGE_TYPES.join(",");

export interface ComposerProps {
  readonly activeTurn: boolean;
  readonly cwd: string | null;
  readonly draftKey?: string | null;
  readonly draftStore?: DraftStore;
  readonly savedPromptStore?: SavedPromptStore;
  readonly blobUrlFactory?: BlobUrlFactory;
  readonly initialText?: string;
  readonly error: string | null;
  readonly models?: readonly Model[];
  readonly modelsLoading?: boolean;
  readonly permissions?: readonly PermissionProfileSummary[];
  readonly permissionsLoading?: boolean;
  readonly recentCwds?: readonly string[];
  readonly mentionReferences?: readonly ComposerMentionReference[];
  readonly mentionsLoading?: boolean;
  readonly mentionsError?: string | null;
  readonly interactionPanel?: ReactNode;
  readonly skills?: readonly SkillMetadata[];
  readonly skillsLoading?: boolean;
  readonly capabilitiesError?: string | null;
  readonly canRunImmediateCommands?: boolean;
  readonly onLoadSkills?: (forceReload?: boolean) => Promise<void>;
  readonly onLoadMentions?: (forceReload?: boolean) => Promise<void>;
  readonly onCwdChange?: (cwd: string) => void;
  readonly onPickCwd?: () => Promise<string | null>;
  readonly onRunImmediateCommand?: (command: "compact" | "review") => Promise<boolean>;
  readonly onOpenSettings?: () => void;
  readonly onSearchFiles?: (query: string) => Promise<readonly FuzzyFileSearchResult[]>;
  readonly onSend: (
    input: TurnStartParams["input"],
    configuration?: ConversationTurnConfiguration,
  ) => Promise<boolean>;
  readonly onStop: () => Promise<boolean>;
  readonly stopping: boolean;
  readonly submitting: boolean;
  readonly showProjectPicker: boolean;
}

export function Composer({
  activeTurn,
  cwd,
  draftKey = null,
  draftStore = persistentDraftStore,
  savedPromptStore = persistentSavedPromptStore,
  blobUrlFactory = browserBlobUrls,
  initialText = "",
  error,
  models = [],
  modelsLoading = false,
  permissions = [],
  permissionsLoading = false,
  recentCwds = [],
  mentionReferences = [],
  mentionsLoading = false,
  mentionsError = null,
  interactionPanel,
  skills = [],
  skillsLoading = false,
  capabilitiesError = null,
  canRunImmediateCommands = false,
  onLoadSkills,
  onLoadMentions,
  onCwdChange,
  onPickCwd,
  onRunImmediateCommand,
  onOpenSettings,
  onSearchFiles,
  onSend,
  onStop,
  stopping,
  submitting,
  showProjectPicker,
}: ComposerProps) {
  const [text, setText] = useState(initialText);
  const [tokens, setTokens] = useState<readonly StructuredInput[]>([]);
  const [attachments, setAttachments] = useState<readonly DraftAttachment[]>([]);
  const [selectedTokenIndex, setSelectedTokenIndex] = useState<number | null>(null);
  const [editingCwd, setEditingCwd] = useState(false);
  const [cwdInput, setCwdInput] = useState(cwd ?? "");
  const [cwdError, setCwdError] = useState<string | null>(null);
  const [pickingCwd, setPickingCwd] = useState(false);
  const [trigger, setTrigger] = useState<Trigger | null>(() =>
    findTrigger(initialText, initialText.length),
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [fileResults, setFileResults] = useState<readonly FuzzyFileSearchResult[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [fileSearchError, setFileSearchError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedEffort, setSelectedEffort] = useState<string | null>(null);
  const [selectedPermission, setSelectedPermission] = useState<string | null>(null);
  const [preparingAttachments, setPreparingAttachments] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [loadedDraftKey, setLoadedDraftKey] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [savedPromptPickerOpen, setSavedPromptPickerOpen] = useState(false);
  const [savedPromptManagerOpen, setSavedPromptManagerOpen] = useState(false);
  const [savedPromptManagerCreate, setSavedPromptManagerCreate] = useState(false);
  const [savedPromptQuery, setSavedPromptQuery] = useState("");
  const [sendingPromptId, setSendingPromptId] = useState<string | null>(null);
  const [savedPromptSendError, setSavedPromptSendError] = useState<string | null>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const savedPromptSearchRef = useRef<HTMLInputElement>(null);
  const fileSearchRef = useRef(0);
  const composingRef = useRef(false);
  const sendingRef = useRef(false);
  const previousDraftKeyRef = useRef(draftKey);
  const preserveDraftForNextKeyRef = useRef(false);
  const currentDraftRef = useRef({ text, tokens });
  const composerSelectionRef = useRef<{
    start: number;
    end: number;
    direction: "forward" | "backward" | "none";
  }>({ start: initialText.length, end: initialText.length, direction: "none" });
  const savedPrompts = useSavedPrompts(savedPromptStore);
  currentDraftRef.current = { text, tokens };
  const normalized = text.trim();
  const defaultModel = models.find(({ isDefault }) => isDefault) ?? models[0] ?? null;
  const activeModel = models.find(({ model }) => model === selectedModel)
    ?? defaultModel;
  const selectedModelRejectsImages = activeModel !== null
    && !(activeModel.inputModalities ?? ["text"]).includes("image");
  const hasInvalidAttachment = (selectedModelRejectsImages && attachments.length > 0)
    || attachments.some(({ error }) => error !== null);
  const canSend = (
    normalized.length > 0 ||
    tokens.length > 0 ||
    attachments.some(({ blob }) => blob !== null)
  ) && !hasInvalidAttachment && !preparingAttachments && !submitting && !stopping;
  const normalizedSavedPromptQuery = savedPromptQuery.trim().toLocaleLowerCase();
  const filteredSavedPrompts = useMemo(() => normalizedSavedPromptQuery.length === 0
    ? savedPrompts.prompts
    : savedPrompts.prompts.filter((prompt) =>
      `${prompt.name}\n${prompt.content}`.toLocaleLowerCase().includes(normalizedSavedPromptQuery)),
  [normalizedSavedPromptQuery, savedPrompts.prompts]);
  const cwdOptions = useMemo(() => {
    const directories = new Set(recentCwds.map((directory) => directory.trim()));
    directories.delete("");
    if (cwd !== null) {
      directories.add(cwd);
    }
    return [...directories];
  }, [cwd, recentCwds]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) {
      return;
    }
    textarea.style.height = "0";
    textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  useEffect(() => {
    setCwdInput(cwd ?? "");
    setEditingCwd(false);
    setCwdError(null);
  }, [cwd]);

  useEffect(() => {
    if (
      selectedModel !== null &&
      !models.some(({ model }) => model === selectedModel)
    ) {
      setSelectedModel(null);
    }
    if (
      selectedEffort !== null &&
      !activeModel?.supportedReasoningEfforts.some(
        ({ reasoningEffort }) => reasoningEffort === selectedEffort,
      )
    ) {
      setSelectedEffort(null);
    }
  }, [activeModel, models, selectedEffort, selectedModel]);

  useEffect(() => {
    if (selectedPermission !== null && !permissions.some(({ id }) => id === selectedPermission)) {
      setSelectedPermission(null);
    }
  }, [permissions, selectedPermission]);

  useEffect(() => {
    if (!menuOpen && !savedPromptPickerOpen) return;
    const handleOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !plusMenuRef.current?.contains(event.target)) {
        setMenuOpen(false);
        setSavedPromptPickerOpen(false);
      }
    };
    document.addEventListener("pointerdown", handleOutsideClick);
    return () => document.removeEventListener("pointerdown", handleOutsideClick);
  }, [menuOpen, savedPromptPickerOpen]);

  useEffect(() => {
    if (savedPromptPickerOpen) savedPromptSearchRef.current?.focus();
  }, [savedPromptPickerOpen]);

  useEffect(() => {
    let disposed = false;
    const previousDraftKey = previousDraftKeyRef.current;
    previousDraftKeyRef.current = draftKey;
    setLoadedDraftKey(null);
    if (preserveDraftForNextKeyRef.current && previousDraftKey !== draftKey) {
      preserveDraftForNextKeyRef.current = false;
      setLoadedDraftKey(draftKey);
      const preserved = currentDraftRef.current;
      if (draftKey !== null) {
        void draftStore.save(draftKey, preserved).then(
          () => previousDraftKey === null ? undefined : draftStore.delete(previousDraftKey),
        ).catch(() => undefined);
      }
      return () => { disposed = true; };
    }
    setSelectedModel(null);
    setSelectedEffort(null);
    setSelectedPermission(null);
    setAttachments([]);
    if (draftKey === null) {
      setText(initialText);
      setTokens([]);
      return () => { disposed = true; };
    }
    void draftStore.load(draftKey).then(
      (stored) => {
        if (disposed) return;
        if (stored === null) {
          setText("");
          setTokens([]);
        } else {
          setText(stored.text);
          setTokens(stored.tokens);
        }
        setLoadedDraftKey(draftKey);
      },
      () => {
        if (disposed) return;
        setText("");
        setTokens([]);
        setLoadedDraftKey(draftKey);
      },
    );
    return () => { disposed = true; };
  }, [draftKey, draftStore, initialText]);

  useEffect(() => {
    if (draftKey === null || loadedDraftKey !== draftKey) {
      return;
    }
    const timeout = window.setTimeout(() => {
      const persistence = text.length === 0 && tokens.length === 0
        ? draftStore.delete(draftKey)
        : draftStore.save(draftKey, { text, tokens });
      void persistence.catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [draftKey, draftStore, loadedDraftKey, text, tokens]);

  useEffect(() => {
    if (trigger?.kind !== "$" || onLoadSkills === undefined) {
      return;
    }
    void onLoadSkills(false);
  }, [onLoadSkills, trigger?.kind]);

  useEffect(() => {
    if (trigger?.kind !== "@" || onLoadMentions === undefined) {
      return;
    }
    void onLoadMentions(false);
  }, [onLoadMentions, trigger?.kind]);

  useEffect(() => {
    if (trigger?.kind !== "@" || onSearchFiles === undefined || cwd === null) {
      setFileResults([]);
      setFileSearchLoading(false);
      setFileSearchError(null);
      return;
    }
    const request = ++fileSearchRef.current;
    const timeout = window.setTimeout(() => {
      setFileSearchLoading(true);
      setFileSearchError(null);
      void onSearchFiles(trigger.query).then(
        (results) => {
          if (request === fileSearchRef.current) {
            setFileResults(results);
            setFileSearchLoading(false);
          }
        },
        () => {
          if (request === fileSearchRef.current) {
            setFileResults([]);
            setFileSearchLoading(false);
            setFileSearchError("无法搜索服务器工作区文件");
          }
        },
      );
    }, 160);
    return () => window.clearTimeout(timeout);
  }, [cwd, onSearchFiles, trigger]);

  const suggestions = useMemo(
    () => buildSuggestions(trigger, {
      activeTurn,
      cwd,
      fileResults,
      fileSearchError,
      fileSearchLoading,
      mentionReferences,
      mentionsError,
      mentionsLoading,
      skills,
      skillsLoading,
      supportsImmediateCommands: canRunImmediateCommands && onRunImmediateCommand !== undefined,
    }),
    [activeTurn, canRunImmediateCommands, cwd, fileResults, fileSearchError, fileSearchLoading, mentionReferences, mentionsError, mentionsLoading, onRunImmediateCommand, skills, skillsLoading, trigger],
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [trigger?.kind, trigger?.query]);

  const turnConfiguration = (): ConversationTurnConfiguration => ({
    ...(cwd === null ? {} : { cwd }),
    ...(selectedModel === null ? {} : { model: selectedModel }),
    ...(selectedEffort === null ? {} : { effort: selectedEffort }),
    ...(selectedPermission === null ? {} : { permissions: selectedPermission }),
  });

  const send = async () => {
    if (!canSend || sendingRef.current) {
      return;
    }
    preserveDraftForNextKeyRef.current = false;
    sendingRef.current = true;
    setPreparingAttachments(true);
    try {
      const prepared = await Promise.all(attachments.map(async (attachment) => {
        if (attachment.blob === null) {
          return { id: attachment.id, url: null };
        }
        try {
          return { id: attachment.id, url: await readBlobDataUrl(attachment.blob) };
        } catch {
          return { id: attachment.id, url: null };
        }
      }));
      const failed = new Set(
        prepared.filter(({ url }) => url === null).map(({ id }) => id),
      );
      if (failed.size > 0) {
        setAttachments((current) => current.map((attachment) =>
          failed.has(attachment.id)
            ? { ...attachment, error: "无法读取此图片" }
            : attachment,
        ));
        return;
      }
      const input: TurnStartParams["input"] = [
        ...(normalized.length === 0 ? [] : [{ type: "text" as const, text: normalized }]),
        ...tokens,
        ...prepared.flatMap(({ url }) =>
          url === null ? [] : [{ type: "image" as const, url }],
        ),
      ];
      if (await onSend(input, turnConfiguration())) {
        setText("");
        setTokens([]);
        setAttachments([]);
        setSelectedTokenIndex(null);
        setTrigger(null);
      }
    } finally {
      sendingRef.current = false;
      setPreparingAttachments(false);
    }
  };

  const updateTrigger = (value: string, cursor: number, composing = false) => {
    setTrigger(composing ? null : findTrigger(value, cursor));
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setText(value);
    setSelectedTokenIndex(null);
    updateTrigger(
      value,
      event.target.selectionStart,
      composingRef.current || isComposingEvent(event.nativeEvent),
    );
  };

  const chooseSuggestion = async (suggestion: Suggestion, keepTyping: boolean) => {
    if (trigger === null || suggestion.disabled || suggestion.value === undefined) {
      return;
    }
    if (suggestion.kind === "command") {
      const command = suggestion.value as SlashCommand;
      if (command.behavior === "compact" || command.behavior === "review") {
        setText(replaceTrigger(text, trigger, ""));
        setTrigger(null);
        await onRunImmediateCommand?.(command.behavior);
      } else if (command.behavior === "attach") {
        setText(replaceTrigger(text, trigger, ""));
        setTrigger(null);
        attachmentInputRef.current?.click();
      } else if (command.behavior === "settings") {
        setText(replaceTrigger(text, trigger, ""));
        setTrigger(null);
        onOpenSettings?.();
      } else if (command.behavior === "insert") {
        const replacement = `/${command.name}${keepTyping ? " " : " "}`;
        const next = replaceTrigger(text, trigger, replacement);
        setText(next);
        setTrigger(null);
        focusAt(textareaRef.current, trigger.start + replacement.length);
      }
      return;
    }
    const nextToken: StructuredInput = suggestion.kind === "skill"
      ? {
          type: "skill",
          name: (suggestion.value as SkillMetadata).name,
          path: (suggestion.value as SkillMetadata).path,
        }
      : suggestion.kind === "app" || suggestion.kind === "plugin"
        ? {
            type: "mention",
            name: (suggestion.value as ComposerMentionReference).name,
            path: (suggestion.value as ComposerMentionReference).path,
          }
        : {
          type: "mention",
          name: (suggestion.value as FuzzyFileSearchResult).file_name,
          path: (suggestion.value as FuzzyFileSearchResult).path,
        };
    const replacement = keepTyping ? " " : "";
    const next = replaceTrigger(text, trigger, replacement);
    setText(next);
    setTokens((current) => [...current, nextToken]);
    setTrigger(null);
    focusAt(textareaRef.current, trigger.start + replacement.length);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Backspace" && text.length === 0 && tokens.length > 0) {
      event.preventDefault();
      const lastIndex = tokens.length - 1;
      if (selectedTokenIndex === lastIndex) {
        setTokens((current) => current.slice(0, -1));
        setSelectedTokenIndex(null);
      } else {
        setSelectedTokenIndex(lastIndex);
      }
      return;
    }
    if (trigger !== null && suggestions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) => nextSelectableIndex(suggestions, current, event.key === "ArrowDown" ? 1 : -1));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setTrigger(null);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const suggestion = suggestions[selectedIndex];
        if (suggestion !== undefined && !suggestion.disabled) {
          event.preventDefault();
          void chooseSuggestion(suggestion, event.key === "Tab");
          return;
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const handleUploadClick = () => {
    setMenuOpen(false);
    attachmentInputRef.current?.click();
  };

  const rememberComposerSelection = () => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    composerSelectionRef.current = {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
      direction: textarea.selectionDirection ?? "none",
    };
  };

  const restoreComposerSelection = () => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea === null || textarea.disabled) return;
      const selection = composerSelectionRef.current;
      textarea.focus();
      textarea.setSelectionRange(selection.start, selection.end, selection.direction);
    });
  };

  const openSavedPromptPicker = () => {
    rememberComposerSelection();
    setMenuOpen(false);
    setSavedPromptManagerOpen(false);
    setSavedPromptPickerOpen(true);
    setSavedPromptQuery("");
    setSavedPromptSendError(null);
    savedPrompts.clearError();
    void savedPrompts.reload();
  };

  const openSavedPromptManager = (startCreating = false) => {
    setMenuOpen(false);
    setSavedPromptPickerOpen(false);
    setSavedPromptManagerCreate(startCreating);
    setSavedPromptManagerOpen(true);
    setSavedPromptSendError(null);
    void savedPrompts.reload();
  };

  const sendSavedPrompt = async (prompt: SavedPrompt) => {
    if (sendingRef.current || submitting || stopping || preparingAttachments) return;
    sendingRef.current = true;
    setSendingPromptId(prompt.promptId);
    setSavedPromptSendError(null);
    if (showProjectPicker) preserveDraftForNextKeyRef.current = true;
    try {
      const sent = await onSend(
        [{ type: "text", text: prompt.content }],
        turnConfiguration(),
      );
      if (sent) {
        setSavedPromptPickerOpen(false);
      } else {
        if (showProjectPicker) {
          window.setTimeout(() => {
            if (previousDraftKeyRef.current === draftKey) {
              preserveDraftForNextKeyRef.current = false;
            }
          }, 0);
        }
        setSavedPromptSendError("未能发送常用提示词，当前草稿未受影响");
      }
    } finally {
      sendingRef.current = false;
      setSendingPromptId(null);
      restoreComposerSelection();
    }
  };

  const triggerMention = () => {
    setMenuOpen(false);
    const textarea = textareaRef.current;
    if (!textarea) return;

    const value = text;
    const cursor = textarea.selectionStart ?? value.length;

    const newValue = value.slice(0, cursor) + "@" + value.slice(textarea.selectionEnd ?? cursor);
    setText(newValue);

    textarea.focus();
    setTimeout(() => {
      const newCursor = cursor + 1;
      textarea.selectionStart = newCursor;
      textarea.selectionEnd = newCursor;
      updateTrigger(newValue, newCursor);
    }, 0);
  };

  const addFiles = async (files: FileList | readonly File[]) => {
    const pending = await Promise.all([...files].map(readAttachment));
    setAttachments((current) => [...current, ...pending]);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter(({ kind }) => kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    void addFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (preparingAttachments || submitting) {
      return;
    }
    if (event.dataTransfer.files.length > 0) {
      void addFiles(event.dataTransfer.files);
    }
  };

  const applyCwd = () => {
    const value = cwdInput.trim();
    if (!isAbsolutePath(value)) {
      setCwdError("请输入服务器上的绝对路径");
      return;
    }
    onCwdChange?.(value);
    setEditingCwd(false);
    setCwdError(null);
    textareaRef.current?.focus();
  };

  const chooseCwd = async () => {
    if (onPickCwd === undefined) return;
    setPickingCwd(true);
    setCwdError(null);
    try {
      const value = await onPickCwd();
      if (value !== null) {
        onCwdChange?.(value);
      }
    } catch {
      setCwdError("无法打开系统目录选择器");
      setEditingCwd(true);
    } finally {
      setPickingCwd(false);
    }
  };

  return (
    <section className={styles.composer}>
      {interactionPanel}
      {error === null ? null : <div className={styles.error} role="alert">{error}</div>}
      {capabilitiesError === null ? null : <div className={styles.capabilityError} role="status">{capabilitiesError}</div>}
      {showProjectPicker ? (
        <div className={styles.projectBar}>
          <div className={styles.cwdControl}>
            <ProjectPicker
              cwd={cwd}
              directories={cwdOptions}
              disabled={onCwdChange === undefined || activeTurn || submitting}
              onBrowse={onPickCwd === undefined ? undefined : () => void chooseCwd()}
              onCustom={() => {
                setCwdInput(cwd ?? "");
                setCwdError(null);
                setEditingCwd(true);
              }}
              onSelect={(directory) => onCwdChange?.(directory)}
              picking={pickingCwd}
            />
            {editingCwd ? (
              <div className={styles.cwdEditor}>
                <label>
                  <span>服务器工作目录</span>
                  <input autoFocus onChange={(event) => setCwdInput(event.target.value)} onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      applyCwd();
                    } else if (event.key === "Escape") {
                      setEditingCwd(false);
                    }
                  }} placeholder="/workspace/project" value={cwdInput} />
                </label>
                {cwdError === null ? null : <small role="alert">{cwdError}</small>}
                <div><button onClick={() => setEditingCwd(false)} type="button">取消</button><button onClick={applyCwd} type="button">应用</button></div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <div
        className={styles.surface}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        {trigger === null ? null : (
          <SuggestionMenu
            items={suggestions}
            menuKind={trigger.kind}
            onChoose={(item) => void chooseSuggestion(item, false)}
            onHover={setSelectedIndex}
            selectedIndex={selectedIndex}
          />
        )}
        <textarea
          aria-label="任务输入"
          data-composer-input
          disabled={submitting || preparingAttachments}
          onChange={handleChange}
          onClick={(event) => updateTrigger(text, event.currentTarget.selectionStart)}
          onCompositionStart={() => {
            composingRef.current = true;
            setTrigger(null);
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            updateTrigger(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => {
            if (!event.nativeEvent.isComposing && !["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) {
              updateTrigger(text, event.currentTarget.selectionStart);
            }
          }}
          placeholder={activeTurn ? "输入要追加的内容" : "向 Codex 描述任务"}
          onPaste={handlePaste}
          onSelect={rememberComposerSelection}
          ref={textareaRef}
          rows={1}
          value={text}
        />
        <input
          accept={IMAGE_ACCEPT}
          aria-label="选择图片附件"
          className={styles.fileInput}
          disabled={submitting || preparingAttachments}
          multiple
          onChange={(event) => {
            if (event.target.files !== null) {
              void addFiles(event.target.files);
            }
            event.target.value = "";
          }}
          ref={attachmentInputRef}
          type="file"
        />
        {attachments.length === 0 ? null : (
          <div aria-label="附件" className={styles.attachments}>
            {attachments.map((attachment) => (
              <article className={styles.attachmentCard} data-error={attachment.error !== null} key={attachment.id}>
                <AttachmentThumbnail attachment={attachment} blobUrlFactory={blobUrlFactory} />
                <span>
                  <strong>{attachment.name}</strong>
                  <small>{attachment.error ?? (selectedModelRejectsImages ? "当前模型不支持图片输入" : formatFileSize(attachment.size))}</small>
                </span>
                <button aria-label={`移除 ${attachment.name}`} disabled={preparingAttachments || submitting} onClick={() => setAttachments((current) => current.filter(({ id }) => id !== attachment.id))} type="button">×</button>
              </article>
            ))}
          </div>
        )}
        {tokens.length === 0 ? null : (
          <div aria-label="结构化输入" className={styles.tokens}>
            {tokens.map((token, index) => (
              <span
                className={styles.token}
                data-selected={selectedTokenIndex === index}
                key={`${token.type}:${token.path}:${index}`}
                onClick={() => setSelectedTokenIndex(index)}
              >
                <span>{token.type === "skill" ? "$" : "@"}{token.name}</span>
                <button aria-label={`移除 ${token.name}`} onClick={() => setTokens((current) => current.filter((_, itemIndex) => itemIndex !== index))} type="button">×</button>
              </span>
            ))}
          </div>
        )}
        <footer>
          <div className={styles.context}>
            <div className={styles.plusMenuContainer} ref={plusMenuRef}>
              <button
                aria-expanded={menuOpen || savedPromptPickerOpen}
                aria-haspopup="true"
                aria-label="添加内容"
                className={styles.addButton}
                disabled={submitting || preparingAttachments || stopping}
                onClick={() => {
                  if (savedPromptPickerOpen) {
                    setSavedPromptPickerOpen(false);
                    restoreComposerSelection();
                  } else {
                    setMenuOpen((prev) => !prev);
                  }
                }}
                onPointerDown={rememberComposerSelection}
                title="添加内容"
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path
                    d="M12 5v14M5 12h14"
                    style={{
                      transform: menuOpen || savedPromptPickerOpen ? "rotate(45deg)" : "rotate(0deg)",
                      transformOrigin: "center",
                      transition: "transform 0.2s ease",
                    }}
                  />
                </svg>
              </button>
              {menuOpen && (
                <div className={styles.plusMenu} role="menu">
                  <button
                    onClick={handleUploadClick}
                    role="menuitem"
                    type="button"
                  >
                    <svg aria-hidden="true" className={styles.menuIcon} viewBox="0 0 24 24">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="9" cy="9" r="2" />
                      <path d="M21 15l-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                    </svg>
                    <div className={styles.menuText}>
                      <strong>添加图片</strong>
                      <small>选择本地图片并上传</small>
                    </div>
                  </button>
                  <button
                    onClick={triggerMention}
                    role="menuitem"
                    type="button"
                  >
                    <svg aria-hidden="true" className={styles.menuIcon} viewBox="0 0 24 24">
                      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                      <path d="M10 9H8" />
                      <path d="M16 13H8" />
                      <path d="M16 17H8" />
                    </svg>
                    <div className={styles.menuText}>
                      <strong>引用项目引用</strong>
                      <small>提及文件、目录或符号 (@)</small>
                    </div>
                  </button>
                  <button
                    onClick={openSavedPromptPicker}
                    role="menuitem"
                    type="button"
                  >
                    <svg aria-hidden="true" className={styles.menuIcon} viewBox="0 0 24 24">
                      <path d="M8 4h8" />
                      <path d="M6 8h12" />
                      <path d="M5 12h10" />
                      <path d="M5 16h7" />
                      <path d="m17 15 3 2-3 2Z" />
                    </svg>
                    <div className={styles.menuText}>
                      <strong>常用提示词</strong>
                      <small>选择并立即发送</small>
                    </div>
                  </button>
                </div>
              )}
              {savedPromptPickerOpen ? (
                <div
                  aria-label="选择常用提示词"
                  className={styles.savedPromptPicker}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setSavedPromptPickerOpen(false);
                      restoreComposerSelection();
                    }
                  }}
                  role="dialog"
                >
                  <header>
                    <div>
                      <strong>常用提示词</strong>
                      <small>{activeTurn ? "点击后立即追加" : "点击后立即发送"}</small>
                    </div>
                    <button aria-label="关闭常用提示词" onClick={() => {
                      setSavedPromptPickerOpen(false);
                      restoreComposerSelection();
                    }} type="button">×</button>
                  </header>
                  <input
                    aria-label="搜索常用提示词"
                    onChange={(event) => setSavedPromptQuery(event.target.value)}
                    placeholder="搜索名称或内容"
                    ref={savedPromptSearchRef}
                    type="search"
                    value={savedPromptQuery}
                  />
                  <div aria-live="polite" className={styles.savedPromptItems}>
                    {savedPrompts.loading && savedPrompts.prompts.length === 0 ? (
                      <p>正在加载常用提示词</p>
                    ) : null}
                    {!savedPrompts.loading && filteredSavedPrompts.length === 0 ? (
                      <div className={styles.savedPromptEmpty}>
                        <strong>{savedPrompts.prompts.length === 0 ? "还没有常用提示词" : "没有匹配的常用提示词"}</strong>
                        <small>{savedPrompts.prompts.length === 0 ? "新建后即可从这里直接发送" : "尝试使用其他搜索词"}</small>
                        {savedPrompts.prompts.length === 0 ? <button onClick={() => openSavedPromptManager(true)} type="button">新建提示词</button> : null}
                      </div>
                    ) : null}
                    {filteredSavedPrompts.map((prompt) => (
                      <button
                        aria-label={`${prompt.name}，${activeTurn ? "立即追加" : "立即发送"}`}
                        disabled={sendingPromptId !== null || submitting || stopping}
                        key={prompt.promptId}
                        onClick={() => void sendSavedPrompt(prompt)}
                        type="button"
                      >
                        <span>
                          <strong>{prompt.name}</strong>
                          <small>{prompt.content}</small>
                        </span>
                        <svg aria-hidden="true" viewBox="0 0 24 24">
                          <path d="m5 12 14-7-4 14-3-6Z" />
                          <path d="m12 13 7-8" />
                        </svg>
                      </button>
                    ))}
                  </div>
                  {savedPrompts.error === null && savedPromptSendError === null ? null : (
                    <div className={styles.savedPromptError} role="alert">
                      {savedPromptSendError ?? savedPrompts.error}
                      {savedPrompts.error === null ? null : <button disabled={savedPrompts.loading} onClick={() => void savedPrompts.reload()} type="button">重试</button>}
                    </div>
                  )}
                  <footer>
                    <button onClick={() => openSavedPromptManager()} type="button">管理常用提示词…</button>
                  </footer>
                </div>
              ) : null}
            </div>
            <PermissionPicker
              disabled={activeTurn || permissionsLoading}
              loading={permissionsLoading}
              onSelect={setSelectedPermission}
              permissions={permissions}
              selectedPermission={selectedPermission}
            />
          </div>
          <ModelPicker
            activeModel={activeModel}
            disabled={modelsLoading || models.length === 0 || activeTurn}
            loading={modelsLoading}
            models={models}
            onSelectEffort={setSelectedEffort}
            onSelectModel={(model) => {
              setSelectedModel(model);
              setSelectedEffort(null);
            }}
            selectedEffort={selectedEffort}
            selectedModel={selectedModel}
          />
          <div className={styles.actions}>
            {activeTurn && canSend ? (
              <button
                aria-label="停止当前回合"
                className={styles.stopSecondary}
                disabled={stopping}
                onClick={() => void onStop()}
                title="停止"
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <rect x="7" y="7" width="10" height="10" rx="1.5" />
                </svg>
              </button>
            ) : null}
            {activeTurn && !canSend ? (
              <button
                aria-label={stopping ? "正在停止" : "停止"}
                className={styles.stopButton}
                disabled={stopping}
                onClick={() => void onStop()}
                title="停止"
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <rect x="7" y="7" width="10" height="10" rx="1.5" />
                </svg>
              </button>
            ) : (
              <button
                aria-label={preparingAttachments ? "正在准备" : submitting ? "正在提交" : activeTurn ? "追加" : "发送"}
                className={styles.sendButton}
                disabled={!canSend}
                onClick={() => void send()}
                title={activeTurn ? "追加" : "发送"}
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />
                </svg>
              </button>
            )}
          </div>
        </footer>
      </div>
      <SavedPromptManagerDialog
        error={savedPrompts.error}
        loading={savedPrompts.loading}
        onClearError={savedPrompts.clearError}
        onClose={() => {
          setSavedPromptManagerOpen(false);
          setSavedPromptManagerCreate(false);
          restoreComposerSelection();
        }}
        onCreate={savedPrompts.create}
        onDelete={savedPrompts.remove}
        onReload={savedPrompts.reload}
        onReorder={savedPrompts.reorder}
        onUpdate={savedPrompts.update}
        open={savedPromptManagerOpen}
        prompts={savedPrompts.prompts}
        saving={savedPrompts.saving}
        startCreating={savedPromptManagerCreate}
      />
    </section>
  );
}

function ProjectPicker({
  cwd,
  directories,
  disabled,
  onBrowse,
  onCustom,
  onSelect,
  picking,
}: {
  readonly cwd: string | null;
  readonly directories: readonly string[];
  readonly disabled: boolean;
  readonly onBrowse: (() => void) | undefined;
  readonly onCustom: () => void;
  readonly onSelect: (directory: string) => void;
  readonly picking: boolean;
}) {
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = cwd === null ? -1 : directories.indexOf(cwd);
  const [focusedIndex, setFocusedIndex] = useState(Math.max(0, selectedIndex));

  useEffect(() => {
    setFocusedIndex(Math.max(0, selectedIndex));
  }, [selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const choose = (index: number) => {
    const directory = directories[index];
    if (directory === undefined) return;
    onSelect(directory);
    setFocusedIndex(index);
    setOpen(false);
  };
  const move = (direction: 1 | -1) => {
    if (directories.length === 0) return;
    setFocusedIndex((current) =>
      (current + direction + directories.length) % directories.length,
    );
  };

  return (
    <div className={styles.projectPicker} ref={containerRef}>
      <button
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="项目"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) setOpen(true);
            else move(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            choose(focusedIndex);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
        title={cwd ?? "选择服务器工作目录"}
        type="button"
      >
        <svg aria-hidden="true" className={styles.projectIcon} viewBox="0 0 24 24">
          <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4l2 2h6A2.5 2.5 0 0 1 20.5 8.5v8A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z" />
        </svg>
        <span className={styles.projectName}>{cwd === null ? "选择项目" : projectName(cwd)}</span>
        <span aria-hidden="true" className={styles.projectChevron}>⌄</span>
      </button>
      {open ? (
        <div aria-label="项目设置" className={styles.projectMenu} id={listboxId} role="dialog">
          {directories.length === 0 ? (
            <p>尚无最近项目</p>
          ) : (
            <div aria-label="选择项目" className={styles.projectOptions} role="listbox">
              {directories.map((directory, index) => (
                <button
                  aria-selected={directory === cwd}
                  data-focused={index === focusedIndex}
                  key={directory}
                  onClick={() => choose(index)}
                  onMouseMove={() => setFocusedIndex(index)}
                  role="option"
                  type="button"
                >
                  <strong>{directory === cwd ? "✓ " : ""}{projectName(directory)}</strong>
                  <small>{directory}</small>
                </button>
              ))}
            </div>
          )}
          <div className={styles.projectActions}>
            <button onClick={() => { setOpen(false); onCustom(); }} type="button">输入自定义目录…</button>
            {onBrowse === undefined ? null : (
              <button disabled={picking} onClick={() => { setOpen(false); onBrowse(); }} type="button">
                {picking ? "正在选择…" : "浏览本地目录…"}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ModelPicker({
  activeModel,
  disabled,
  loading,
  models,
  onSelectEffort,
  onSelectModel,
  selectedEffort,
  selectedModel,
}: {
  readonly activeModel: Model | null;
  readonly disabled: boolean;
  readonly loading: boolean;
  readonly models: readonly Model[];
  readonly onSelectEffort: (effort: string | null) => void;
  readonly onSelectModel: (model: string | null) => void;
  readonly selectedEffort: string | null;
  readonly selectedModel: string | null;
}) {
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);

  useEffect(() => {
    const selectedIndex = models.findIndex(({ model }) => model === selectedModel);
    setFocusedIndex(selectedModel === null || selectedIndex < 0 ? 0 : selectedIndex + 1);
  }, [models, selectedModel]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !containerRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const choose = (index: number) => {
    if (index === 0) {
      onSelectModel(null);
    } else {
      const model = models[index - 1];
      if (model === undefined) return;
      onSelectModel(model.model);
    }
    setFocusedIndex(index);
    setOpen(false);
  };
  const move = (direction: 1 | -1) => {
    const optionCount = models.length + 1;
    setFocusedIndex((current) =>
      (current + direction + optionCount) % optionCount,
    );
  };
  const effortDescription = activeModel?.supportedReasoningEfforts.find(
    ({ reasoningEffort }) => reasoningEffort === selectedEffort,
  )?.description;

  return (
    <div className={styles.modelPicker} ref={containerRef}>
      <button
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="模型"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) setOpen(true);
            else move(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            choose(focusedIndex);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
        title={activeModel === null
          ? undefined
          : `${selectedModel === null ? "服务器默认 · " : ""}${activeModel.description}`}
        type="button"
      >
        {activeModel === null
          ? loading ? "加载模型" : "服务器默认模型"
          : `${selectedModel === null ? "默认 · " : ""}${activeModel.displayName}`}
        <span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div
          aria-label="模型设置"
          className={styles.modelMenu}
          id={listboxId}
          role="dialog"
        >
          <div aria-label="选择模型" className={styles.modelOptions} role="listbox">
            <button
              aria-selected={selectedModel === null}
              data-focused={focusedIndex === 0}
              onClick={() => choose(0)}
              onMouseMove={() => setFocusedIndex(0)}
              role="option"
              type="button"
            >
              <span>
                <strong>{selectedModel === null ? "✓ " : ""}服务器默认</strong>
              </span>
              <small>不覆盖服务器的模型与思考程度配置</small>
            </button>
            {models.map((model, index) => (
              <button
                aria-selected={model.model === selectedModel}
                data-focused={index + 1 === focusedIndex}
                key={model.id}
                onClick={() => choose(index + 1)}
                onMouseMove={() => setFocusedIndex(index + 1)}
                role="option"
                type="button"
              >
                <span>
                  <strong>{model.model === selectedModel ? "✓ " : ""}{model.displayName}</strong>
                  {model.isDefault ? <small className={styles.recommended}>服务端推荐</small> : null}
                </span>
                <small>{model.description}</small>
                <small className={styles.capabilities}>{modelCapabilities(model).join(" · ")}</small>
              </button>
            ))}
          </div>
          {activeModel !== null && activeModel.supportedReasoningEfforts.length > 0 ? (
            <label className={styles.reasoningSetting}>
              <span>思考程度</span>
              <select
                aria-label="思考程度"
                onChange={(event) =>
                  onSelectEffort(event.target.value === "" ? null : event.target.value)
                }
                title={effortDescription}
                value={selectedEffort ?? ""}
              >
                <option value="">服务器默认</option>
                {activeModel.supportedReasoningEfforts.map((effort) => (
                  <option key={effort.reasoningEffort} value={effort.reasoningEffort}>
                    {effort.reasoningEffort} · {effort.description}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PermissionPicker({
  disabled,
  loading,
  onSelect,
  permissions,
  selectedPermission,
}: {
  readonly disabled: boolean;
  readonly loading: boolean;
  readonly onSelect: (permission: string | null) => void;
  readonly permissions: readonly PermissionProfileSummary[];
  readonly selectedPermission: string | null;
}) {
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const options = useMemo(
    () => [{ id: null, allowed: true, description: "使用服务器默认审批、沙箱和网络策略" } as const, ...permissions],
    [permissions],
  );
  const selectedIndex = options.findIndex(({ id }) => id === selectedPermission);
  const [focusedIndex, setFocusedIndex] = useState(Math.max(0, selectedIndex));

  useEffect(() => setFocusedIndex(Math.max(0, selectedIndex)), [selectedIndex]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const choose = (index: number) => {
    const option = options[index];
    if (option === undefined || !option.allowed) return;
    onSelect(option.id);
    setOpen(false);
  };
  const move = (direction: 1 | -1) => {
    setFocusedIndex((current) => nextAllowedPermissionIndex(options, current, direction));
  };
  const selected = options[selectedIndex < 0 ? 0 : selectedIndex];

  return (
    <div className={styles.permissionPicker} ref={containerRef}>
      <button
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="权限"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) setOpen(true);
            else move(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            choose(focusedIndex);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
        title={selected?.description ?? undefined}
        type="button"
      >
        {loading ? "加载权限" : permissionTitle(selected?.id ?? null)}
        <span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div aria-label="选择权限" className={styles.permissionMenu} id={listboxId} role="listbox">
          {options.map((option, index) => {
            const presentation = permissionPresentation(option.id, option.description);
            return (
              <button
                aria-disabled={!option.allowed}
                aria-selected={option.id === selectedPermission}
                data-focused={index === focusedIndex}
                data-risk={presentation.risk}
                key={option.id ?? "default"}
                onClick={() => choose(index)}
                onMouseMove={() => { if (option.allowed) setFocusedIndex(index); }}
                role="option"
                type="button"
              >
                <span><strong>{option.id === selectedPermission ? "✓ " : ""}{permissionTitle(option.id)}</strong>{presentation.risk === "high" ? <small>高风险</small> : null}</span>
                <small>{option.allowed ? presentation.description : "服务器当前不允许选择此配置"}</small>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function modelCapabilities(model: Model): readonly string[] {
  const modalities = model.inputModalities ?? ["text"];
  return [
    ...modalities.map((modality) => modality === "image" ? "图片输入" : "文本输入"),
    ...(model.supportedReasoningEfforts.length === 0 ? [] : ["可调推理强度"]),
    ...(model.supportsPersonality === true ? ["个性化"] : []),
  ];
}

function projectName(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).at(-1) || path;
}

function permissionTitle(id: string | null): string {
  if (id === null) return "默认权限";
  if (id === ":read-only") return "只读";
  if (id === ":workspace") return "工作区写入";
  if (id === ":danger-full-access") return "完全访问";
  return id;
}

function permissionPresentation(
  id: string | null,
  serverDescription?: string | null,
): { readonly description: string; readonly risk: "normal" | "high" } {
  if (id === null) return { description: "使用服务器默认审批、沙箱和网络策略", risk: "normal" };
  if (id === ":read-only") return { description: "文件系统只读，网络受限；需要写入的操作会由服务端处理审批", risk: "normal" };
  if (id === ":workspace") return { description: "允许写入当前工作区，工作区外和网络访问仍受限", risk: "normal" };
  if (id === ":danger-full-access") return { description: "不启用外层沙箱，可访问工作区外文件和网络，请仅在可信任务中使用", risk: "high" };
  return {
    description: serverDescription ?? "服务器自定义审批、沙箱和网络策略",
    risk: "normal",
  };
}

function nextAllowedPermissionIndex(
  options: readonly { readonly allowed: boolean }[],
  current: number,
  direction: 1 | -1,
): number {
  if (options.length === 0) return 0;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (current + direction * offset + options.length) % options.length;
    if (options[index]?.allowed) return index;
  }
  return current;
}

function SuggestionMenu({
  items,
  menuKind,
  onChoose,
  onHover,
  selectedIndex,
}: {
  readonly items: readonly Suggestion[];
  readonly menuKind: MenuKind;
  readonly onChoose: (item: Suggestion) => void;
  readonly onHover: (index: number) => void;
  readonly selectedIndex: number;
}) {
  return (
    <div aria-label="输入建议" className={styles.suggestionMenu} role="listbox">
      {items.length === 0 ? <div className={styles.emptySuggestion}>没有匹配结果</div> : items.map((item, index) => {
        const group = menuKind === "@" ? mentionSuggestionGroup(item) : null;
        const previousGroup = index === 0 || menuKind !== "@"
          ? null
          : mentionSuggestionGroup(items[index - 1]);
        return (
          <div className={styles.suggestionEntry} key={item.id} role="presentation">
            {group !== null && group !== previousGroup ? (
              <div className={styles.suggestionGroup} role="presentation">{group}</div>
            ) : null}
            <button
              aria-disabled={item.disabled}
              aria-selected={index === selectedIndex}
              className={styles.suggestion}
              data-selected={index === selectedIndex}
              onClick={() => onChoose(item)}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => onHover(index)}
              role="option"
              type="button"
            >
              <span className={styles.suggestionIcon}>{item.kind === "command" ? "/" : item.kind === "skill" ? "$" : item.kind === "notice" ? "·" : "@"}</span>
              <span className={styles.suggestionCopy}>
                <strong>{item.name}</strong>
                <small>{item.disabledReason ?? item.description}</small>
              </span>
              <span className={styles.suggestionSource}>{item.source}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function mentionSuggestionGroup(item: Suggestion | undefined): string | null {
  if (item?.kind === "file") return "文件与任务";
  if (item?.kind === "app") return "应用";
  if (item?.kind === "plugin") return "插件";
  if (item?.kind === "notice") return "状态";
  return null;
}

function buildSuggestions(
  trigger: Trigger | null,
  options: {
    readonly activeTurn: boolean;
    readonly cwd: string | null;
    readonly fileResults: readonly FuzzyFileSearchResult[];
    readonly fileSearchError: string | null;
    readonly fileSearchLoading: boolean;
    readonly mentionReferences: readonly ComposerMentionReference[];
    readonly mentionsError: string | null;
    readonly mentionsLoading: boolean;
    readonly skills: readonly SkillMetadata[];
    readonly skillsLoading: boolean;
    readonly supportsImmediateCommands: boolean;
  },
): readonly Suggestion[] {
  if (trigger === null) {
    return [];
  }
  const query = trigger.query.toLocaleLowerCase();
  if (trigger.kind === "/") {
    return SLASH_COMMANDS
      .filter((command) => fuzzyMatch(query, command.name, command.description))
      .map((command) => {
        const immediateUnavailable =
          (command.behavior === "compact" || command.behavior === "review")
          && (!options.supportsImmediateCommands || options.activeTurn);
        return {
          id: `command:${command.name}`,
          kind: "command",
          name: `/${command.name}`,
          description: command.description,
          source: "命令",
          disabled: command.behavior === "unavailable" || immediateUnavailable,
          disabledReason: command.unavailableReason ?? (immediateUnavailable ? "当前回合结束后可用" : undefined),
          value: command,
        } satisfies Suggestion;
      });
  }
  if (trigger.kind === "$") {
    if (options.skillsLoading) {
      return [{ id: "skills-loading", kind: "notice", name: "正在读取技能", description: "请稍候", source: "服务器", disabled: true }];
    }
    return options.skills
      .filter((skill) => fuzzyMatch(query, skill.name, skill.description, skill.shortDescription ?? ""))
      .map((skill) => ({
        id: `skill:${skill.path}`,
        kind: "skill",
        name: `$${skill.name}`,
        description: skill.shortDescription ?? skill.description,
        source: skill.scope,
        disabled: !skill.enabled,
        disabledReason: skill.enabled ? undefined : "此技能已禁用",
        value: skill,
      }));
  }
  const fileSuggestions: Suggestion[] = options.cwd === null
    ? [{ id: "files-no-cwd", kind: "notice", name: "无法搜索文件", description: "请先选择服务器工作目录", source: "服务器", disabled: true }]
    : options.fileSearchLoading
      ? [{ id: "files-loading", kind: "notice", name: "正在搜索工作区", description: "请稍候", source: "服务器", disabled: true }]
      : options.fileSearchError !== null
        ? [{ id: "files-error", kind: "notice", name: "文件搜索失败", description: options.fileSearchError, source: "服务器", disabled: true }]
        : options.fileResults.map((file) => ({
            id: `file:${file.root}:${file.path}`,
            kind: "file",
            name: `@${file.file_name}`,
            description: file.path,
            source: file.match_type === "directory" ? "目录" : "工作区",
            disabled: file.match_type !== "file",
            disabledReason: file.match_type === "file" ? undefined : "目录不能作为文件引用",
            value: file,
          }));
  const referenceSuggestions = options.mentionReferences
    .filter((reference) => fuzzyMatch(query, reference.name, reference.description, ...reference.searchTerms))
    .map((reference) => ({
      id: `${reference.kind}:${reference.path}`,
      kind: reference.kind,
      name: `@${reference.name}`,
      description: reference.description,
      source: reference.kind === "app" ? `应用 · ${reference.source}` : `插件 · ${reference.source}`,
      value: reference,
    } satisfies Suggestion));
  const catalogStatus: Suggestion[] = options.mentionsLoading
    ? [{ id: "mentions-loading", kind: "notice", name: "正在读取应用和插件", description: "请稍候", source: "服务器", disabled: true }]
    : options.mentionsError === null
      ? []
      : [{ id: "mentions-error", kind: "notice", name: "引用目录不完整", description: options.mentionsError, source: "服务器", disabled: true }];
  return [...fileSuggestions, ...referenceSuggestions, ...catalogStatus];
}

function findTrigger(text: string, cursor: number): Trigger | null {
  const beforeCursor = text.slice(0, cursor);
  const match = /(^|\s)([/@$])([^\s/@$]*)$/u.exec(beforeCursor);
  if (match === null) {
    return null;
  }
  const prefix = match[1] ?? "";
  const kind = match[2] as MenuKind;
  const query = match[3] ?? "";
  const start = cursor - query.length - 1;
  if (kind === "/" && start > 0 && !/\s/u.test(text[start - 1] ?? "")) {
    return null;
  }
  return { kind, query, start: start + prefix.length - prefix.length, end: cursor };
}

function replaceTrigger(text: string, trigger: Trigger, replacement: string): string {
  return `${text.slice(0, trigger.start)}${replacement}${text.slice(trigger.end)}`;
}

function fuzzyMatch(query: string, ...values: readonly string[]): boolean {
  if (query.length === 0) {
    return true;
  }
  const candidate = values.join(" ").toLocaleLowerCase();
  let index = 0;
  for (const character of candidate) {
    if (character === query[index]) {
      index += 1;
      if (index === query.length) {
        return true;
      }
    }
  }
  return false;
}

function nextSelectableIndex(items: readonly Suggestion[], current: number, direction: 1 | -1): number {
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (current + direction * offset + items.length) % items.length;
    if (!items[index]?.disabled) {
      return index;
    }
  }
  return current;
}

function focusAt(textarea: HTMLTextAreaElement | null, position: number): void {
  queueMicrotask(() => {
    textarea?.focus();
    textarea?.setSelectionRange(position, position);
  });
}

function isComposingEvent(event: Event): boolean {
  return "isComposing" in event && event.isComposing === true;
}

async function readAttachment(file: File): Promise<DraftAttachment> {
  const base = {
    id: crypto.randomUUID(),
    name: file.name || "未命名附件",
    size: file.size,
  };
  if (!file.type.startsWith("image/")) {
    return { ...base, blob: null, error: "当前服务器输入仅支持图片附件" };
  }
  if (!SUPPORTED_IMAGE_TYPE_SET.has(file.type)) {
    return { ...base, blob: null, error: "不支持此图片格式" };
  }
  if (file.size > MAX_IMAGE_SIZE) {
    return { ...base, blob: null, error: "图片超过 16 MiB 上限" };
  }
  try {
    const blob = file.type === "image/svg+xml"
      ? new Blob([sanitizeSvg(await file.text())], { type: "image/svg+xml;charset=utf-8" })
      : file;
    return { ...base, blob, error: null };
  } catch {
    return { ...base, blob: null, error: "无法读取此图片" };
  }
}

function readBlobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new TypeError("unexpected file result"));
      }
    };
    reader.readAsDataURL(blob);
  });
}

function AttachmentThumbnail({
  attachment,
  blobUrlFactory,
}: {
  readonly attachment: DraftAttachment;
  readonly blobUrlFactory: BlobUrlFactory;
}) {
  const url = useBlobUrl(attachment.blob, blobUrlFactory);
  return url === null
    ? <span aria-hidden="true" className={styles.attachmentPlaceholder}>!</span>
    : <img alt="" src={url} />;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path);
}

function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KiB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}
