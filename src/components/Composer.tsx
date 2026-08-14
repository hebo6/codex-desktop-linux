import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import type { ConversationTurnConfiguration } from "../app/useConversation";
import type { ComposerMentionReference } from "../app/useComposerCapabilities";
import { useSavedPrompts } from "../app/useSavedPrompts";
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
import {
  readClipboardFiles,
  type ClipboardFileResult,
  type ClipboardFilesReader,
} from "../transport/clipboard";
import { draftStore as persistentDraftStore, type DraftStore } from "../transport/drafts";
import {
  savedPromptStore as persistentSavedPromptStore,
  type SavedPrompt,
  type SavedPromptStore,
} from "../transport/savedPrompts";
import {
  ComposerAccessoryPanel,
  ComposerAccessoryRow,
} from "./ComposerAccessoryPanel";
import { ProjectDeleteDialog } from "./ProjectDeleteDialog";
import { SafeMarkdown } from "./SafeMarkdown";
import { SavedPromptManagerDialog } from "./SavedPromptManagerDialog";
import {
  useComposerHistory,
  type ComposerHistorySnapshot,
  type ComposerSelection,
} from "./useComposerHistory";
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
  readonly status: "preparing" | "ready" | "error";
}

interface ComposerContent {
  readonly text: string;
  readonly tokens: readonly StructuredInput[];
}

const MAX_IMAGE_SIZE = 16 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const);
const IMAGE_ACCEPT = SUPPORTED_IMAGE_TYPES.join(",");
type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];
type AttachmentSource = "drop" | "paste" | "picker";
type ImageValidator = (blob: Blob) => Promise<void>;

export interface ComposerProps {
  readonly activeTurn: boolean;
  readonly cwd: string | null;
  readonly draftKey?: string | null;
  readonly draftStore?: DraftStore;
  readonly savedPromptStore?: SavedPromptStore;
  readonly blobUrlFactory?: BlobUrlFactory;
  readonly clipboardFilesReader?: ClipboardFilesReader;
  readonly imageValidator?: ImageValidator;
  readonly initialText?: string;
  readonly error: string | null;
  readonly models?: readonly Model[];
  readonly modelsLoading?: boolean;
  readonly defaultModel?: string | null;
  readonly defaultEffort?: string | null;
  readonly defaultModelSource?: "catalog" | "config" | "thread";
  readonly defaultServiceTier?: string | null;
  readonly defaultServiceTierSource?: "catalog" | "config" | "thread";
  readonly defaultPermission?: string | null;
  readonly permissions?: readonly PermissionProfileSummary[];
  readonly permissionsLoading?: boolean;
  readonly projectCwds?: readonly string[];
  readonly mentionReferences?: readonly ComposerMentionReference[];
  readonly mentionsLoading?: boolean;
  readonly mentionsError?: string | null;
  readonly accessoryPanel?: ReactNode;
  readonly interactionPanel?: ReactNode;
  readonly skills?: readonly SkillMetadata[];
  readonly skillsLoading?: boolean;
  readonly shellCommandActive?: boolean;
  readonly capabilitiesError?: string | null;
  readonly canRunImmediateCommands?: boolean;
  readonly onLoadSkills?: (forceReload?: boolean) => Promise<void>;
  readonly onLoadMentions?: (forceReload?: boolean) => Promise<void>;
  readonly onCwdChange?: (cwd: string) => void;
  readonly onDeleteProject?: (directory: string) => Promise<void>;
  readonly onDraftPresenceChange?: (draftKey: string, present: boolean) => void;
  readonly onPickCwd?: () => Promise<string | null>;
  readonly onRunImmediateCommand?: (command: "compact" | "review") => Promise<boolean>;
  readonly onRunShellCommand: (
    command: string,
    configuration?: ConversationTurnConfiguration,
  ) => Promise<boolean>;
  readonly onOpenSettings?: () => void;
  readonly onSearchFiles?: (query: string) => Promise<readonly FuzzyFileSearchResult[]>;
  readonly onServiceTierChange?: (serviceTier: string) => Promise<boolean>;
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
  clipboardFilesReader = readClipboardFiles,
  imageValidator = validateBrowserImage,
  initialText = "",
  error,
  models = [],
  modelsLoading = false,
  defaultModel: defaultModelId = null,
  defaultEffort = null,
  defaultModelSource = "catalog",
  defaultServiceTier = null,
  defaultServiceTierSource = "catalog",
  defaultPermission = null,
  permissions = [],
  permissionsLoading = false,
  projectCwds = [],
  mentionReferences = [],
  mentionsLoading = false,
  mentionsError = null,
  accessoryPanel,
  interactionPanel,
  skills = [],
  skillsLoading = false,
  shellCommandActive = false,
  capabilitiesError = null,
  canRunImmediateCommands = false,
  onLoadSkills,
  onLoadMentions,
  onCwdChange,
  onDeleteProject,
  onDraftPresenceChange,
  onPickCwd,
  onRunImmediateCommand,
  onRunShellCommand,
  onOpenSettings,
  onSearchFiles,
  onServiceTierChange,
  onSend,
  onStop,
  stopping,
  submitting,
  showProjectPicker,
}: ComposerProps) {
  const {
    breakMerge: breakComposerHistoryMerge,
    change: changeComposerContent,
    getSelection: getComposerSelection,
    redo: redoComposerContent,
    rememberSelection: rememberComposerHistorySelection,
    reset: resetComposerContent,
    undo: undoComposerContent,
    value: composerContent,
  } = useComposerHistory<ComposerContent>(
    { text: initialText, tokens: [] },
    collapsedSelection(initialText.length),
    composerContentsEqual,
  );
  const { text, tokens } = composerContent;
  const [attachments, setAttachments] = useState<readonly DraftAttachment[]>([]);
  const [selectedTokenIndex, setSelectedTokenIndex] = useState<number | null>(null);
  const [editingCwd, setEditingCwd] = useState(false);
  const [cwdInput, setCwdInput] = useState(cwd ?? "");
  const [cwdError, setCwdError] = useState<string | null>(null);
  const [pickingCwd, setPickingCwd] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<string | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [projectDeleteError, setProjectDeleteError] = useState<string | null>(
    null,
  );
  const [trigger, setTrigger] = useState<Trigger | null>(() =>
    initialText.startsWith("!")
      ? null
      : findTrigger(initialText, initialText.length),
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [fileResults, setFileResults] = useState<readonly FuzzyFileSearchResult[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [fileSearchError, setFileSearchError] = useState<string | null>(null);
  const [draftPersistenceError, setDraftPersistenceError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedEffort, setSelectedEffort] = useState<string | null>(null);
  const [selectedServiceTier, setSelectedServiceTier] = useState<string | null>(null);
  const [serviceTierUpdating, setServiceTierUpdating] = useState(false);
  const [selectedPermission, setSelectedPermission] = useState<string | null>(null);
  const [preparingAttachments, setPreparingAttachments] = useState(false);
  const [readingClipboardFiles, setReadingClipboardFiles] = useState(false);
  const [clipboardReadError, setClipboardReadError] = useState<string | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const markdownPreviewHeightRef = useRef<number | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [loadedDraftKey, setLoadedDraftKey] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [savedPromptPickerOpen, setSavedPromptPickerOpen] = useState(false);
  const [savedPromptManagerOpen, setSavedPromptManagerOpen] = useState(false);
  const [savedPromptManagerCreate, setSavedPromptManagerCreate] = useState(false);
  const [savedPromptQuery, setSavedPromptQuery] = useState("");
  const [sendingPromptId, setSendingPromptId] = useState<string | null>(null);
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null);
  const [savedPromptActionError, setSavedPromptActionError] = useState<string | null>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const savedPromptSearchRef = useRef<HTMLInputElement>(null);
  const copiedPromptTimeoutRef = useRef<number | null>(null);
  const fileSearchRef = useRef(0);
  const composingRef = useRef(false);
  const clipboardReadRequestRef = useRef(0);
  const readingClipboardFilesRef = useRef(false);
  const sendingRef = useRef(false);
  const draftKeyRef = useRef(draftKey);
  const previousDraftKeyRef = useRef(draftKey);
  const loadedDraftKeyRef = useRef<string | null>(null);
  const reportedDraftPresenceRef = useRef<{
    readonly draftKey: string;
    readonly present: boolean;
  } | null>(null);
  const preserveDraftForNextKeyRef = useRef(false);
  const currentDraftRef = useRef({ text, tokens });
  const savedPrompts = useSavedPrompts(savedPromptStore);
  draftKeyRef.current = draftKey;
  currentDraftRef.current = { text, tokens };
  const normalized = text.trim();
  const shellMode = text.startsWith("!");
  const shellCommand = shellMode ? text.slice(1).trim() : "";
  const catalogDefaultModel = models.find(({ isDefault }) => isDefault) ?? null;
  const defaultModel = defaultModelId === null
    ? catalogDefaultModel
    : models.find(({ model }) => model === defaultModelId) ?? null;
  const activeModel = models.find(({ model }) => model === selectedModel)
    ?? defaultModel;
  const fastTier = useMemo(() => findFastServiceTier(activeModel), [activeModel]);
  const knownFastServiceTiers = useMemo(
    () => new Set([
      "fast",
      ...models.flatMap((model) => {
        const tier = findFastServiceTier(model);
        return tier === null ? [] : [tier.id];
      }),
    ]),
    [models],
  );
  const inheritedServiceTier = defaultServiceTier ?? (
    defaultServiceTierSource === "thread" ? null : activeModel?.defaultServiceTier ?? null
  );
  const activeServiceTier = selectedServiceTier ?? inheritedServiceTier;
  const fastEnabled = fastTier !== null && isFastServiceTier(
    activeServiceTier,
    knownFastServiceTiers,
  );
  const serviceTierForTurn = selectedServiceTier !== null
    ? isFastServiceTier(selectedServiceTier, knownFastServiceTiers)
      ? fastTier?.id ?? "default"
      : selectedServiceTier
    : selectedModel !== null && isFastServiceTier(inheritedServiceTier, knownFastServiceTiers)
      ? fastTier?.id ?? "default"
      : null;
  const selectedModelRejectsImages = activeModel !== null
    && !(activeModel.inputModalities ?? ["text"]).includes("image");
  const hasPreparingAttachment = attachments.some(({ status }) => status === "preparing");
  const hasInvalidAttachment = (selectedModelRejectsImages && attachments.length > 0)
    || attachments.some(({ error }) => error !== null);
  const hasShellIncompatibleContent =
    shellMode && (tokens.length > 0 || attachments.length > 0);
  const hasSubmittableContent = shellMode
    ? shellCommand.length > 0 && !hasShellIncompatibleContent
    : (
        normalized.length > 0 ||
        tokens.length > 0 ||
        attachments.some(({ blob }) => blob !== null)
      ) && !shellCommandActive;
  const canSend = hasSubmittableContent &&
    !hasInvalidAttachment &&
    !hasPreparingAttachment &&
    !preparingAttachments &&
    !serviceTierUpdating &&
    !readingClipboardFiles &&
    !submitting &&
    !stopping;
  const normalizedSavedPromptQuery = savedPromptQuery.trim().toLocaleLowerCase();
  const filteredSavedPrompts = useMemo(() => normalizedSavedPromptQuery.length === 0
    ? savedPrompts.prompts
    : savedPrompts.prompts.filter((prompt) =>
      `${prompt.name}\n${prompt.content}`.toLocaleLowerCase().includes(normalizedSavedPromptQuery)),
  [normalizedSavedPromptQuery, savedPrompts.prompts]);
  const cwdOptions = projectCwds;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) {
      return;
    }
    textarea.style.height = "0";
    textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [markdownPreview, text]);

  useEffect(() => {
    setCwdInput(cwd ?? "");
    setEditingCwd(false);
    setCwdError(null);
  }, [cwd]);

  useEffect(() => {
    setMarkdownPreview(false);
  }, [draftKey]);

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

  useEffect(() => () => {
    if (copiedPromptTimeoutRef.current !== null) {
      window.clearTimeout(copiedPromptTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    const previousDraftKey = previousDraftKeyRef.current;
    const previousDraftWasLoaded = loadedDraftKeyRef.current === previousDraftKey;
    previousDraftKeyRef.current = draftKey;
    loadedDraftKeyRef.current = null;
    setLoadedDraftKey(null);
    if (preserveDraftForNextKeyRef.current && previousDraftKey !== draftKey) {
      preserveDraftForNextKeyRef.current = false;
      loadedDraftKeyRef.current = draftKey;
      setLoadedDraftKey(draftKey);
      const preserved = currentDraftRef.current;
      if (draftKey !== null) {
        const persisted = preserved.text.length === 0 && preserved.tokens.length === 0
          ? null
          : preserved;
        const persistence = previousDraftKey === null
          ? persisted === null
            ? draftStore.delete(draftKey)
            : draftStore.save(draftKey, persisted)
          : draftStore.transition(previousDraftKey, draftKey, persisted);
        void persistence.then(
          () => setDraftPersistenceError(null),
          () => setDraftPersistenceError("草稿保存失败，当前内容可能无法恢复"),
        );
      }
      return () => { disposed = true; };
    }
    clipboardReadRequestRef.current += 1;
    readingClipboardFilesRef.current = false;
    setReadingClipboardFiles(false);
    setAttachments([]);
    setClipboardReadError(null);
    if (
      previousDraftKey !== null &&
      previousDraftKey !== draftKey &&
      previousDraftWasLoaded &&
      !sendingRef.current
    ) {
      const previous = currentDraftRef.current;
      const persistence = previous.text.length === 0 && previous.tokens.length === 0
        ? draftStore.delete(previousDraftKey)
        : draftStore.save(previousDraftKey, previous);
      void persistence.then(
        () => setDraftPersistenceError(null),
        () => setDraftPersistenceError("草稿保存失败，当前内容可能无法恢复"),
      );
    }
    setSelectedModel(null);
    setSelectedEffort(null);
    setSelectedServiceTier(null);
    setServiceTierUpdating(false);
    setSelectedPermission(null);
    if (draftKey === null) {
      resetComposerContent(
        { text: initialText, tokens: [] },
        collapsedSelection(initialText.length),
      );
      return () => { disposed = true; };
    }
    resetComposerContent(
      { text: "", tokens: [] },
      collapsedSelection(0),
    );
    void draftStore.load(draftKey).then(
      (stored) => {
        if (disposed) return;
        const restored = stored ?? { text: "", tokens: [] };
        setDraftPersistenceError(null);
        resetComposerContent(
          restored,
          collapsedSelection(restored.text.length),
        );
        loadedDraftKeyRef.current = draftKey;
        setLoadedDraftKey(draftKey);
      },
      () => {
        if (disposed) return;
        setDraftPersistenceError("草稿读取失败，请切换会话后重试");
        resetComposerContent(
          { text: "", tokens: [] },
          collapsedSelection(0),
        );
        loadedDraftKeyRef.current = draftKey;
        setLoadedDraftKey(draftKey);
      },
    );
    return () => { disposed = true; };
  }, [draftKey, draftStore, initialText, resetComposerContent]);

  useEffect(() => {
    if (draftKey === null || loadedDraftKey !== draftKey) {
      return;
    }
    const timeout = window.setTimeout(() => {
      const persistence = text.length === 0 && tokens.length === 0
        ? draftStore.delete(draftKey)
        : draftStore.save(draftKey, { text, tokens });
      void persistence.then(
        () => setDraftPersistenceError(null),
        () => setDraftPersistenceError("草稿保存失败，当前内容可能无法恢复"),
      );
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [draftKey, draftStore, loadedDraftKey, text, tokens]);

  useEffect(() => () => {
    const currentDraftKey = draftKeyRef.current;
    if (
      currentDraftKey === null ||
      loadedDraftKeyRef.current !== currentDraftKey ||
      sendingRef.current
    ) {
      return;
    }
    const current = currentDraftRef.current;
    const persistence =
      current.text.length === 0 && current.tokens.length === 0
        ? draftStore.delete(currentDraftKey)
        : draftStore.save(currentDraftKey, current);
    void persistence.catch(() => undefined);
  }, [draftStore]);

  useEffect(() => {
    if (
      draftKey === null ||
      loadedDraftKey !== draftKey ||
      onDraftPresenceChange === undefined
    ) {
      return;
    }
    const present = text.length > 0 || tokens.length > 0;
    const reported = reportedDraftPresenceRef.current;
    if (reported?.draftKey === draftKey && reported.present === present) {
      return;
    }
    reportedDraftPresenceRef.current = { draftKey, present };
    onDraftPresenceChange(draftKey, present);
  }, [draftKey, loadedDraftKey, onDraftPresenceChange, text, tokens]);

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
    ...(serviceTierForTurn === null ? {} : { serviceTier: serviceTierForTurn }),
  });

  const toggleFast = async () => {
    if (
      fastTier === null ||
      activeTurn ||
      submitting ||
      stopping ||
      serviceTierUpdating
    ) {
      return;
    }
    const previous = selectedServiceTier;
    const next = fastEnabled ? "default" : fastTier.id;
    setSelectedServiceTier(next);
    if (
      showProjectPicker ||
      onServiceTierChange === undefined
    ) {
      return;
    }
    setServiceTierUpdating(true);
    const updated = await onServiceTierChange(next);
    if (!updated) {
      setSelectedServiceTier(previous);
    }
    setServiceTierUpdating(false);
  };

  const releaseDraftPreservationIfUnchanged = () => {
    const sourceDraftKey = draftKey;
    window.setTimeout(() => {
      if (draftKeyRef.current === sourceDraftKey) {
        preserveDraftForNextKeyRef.current = false;
      }
    }, 0);
  };

  const clearSubmittedDraft = async (
    sourceDraftKey: string | null,
    cleanupError: string,
  ) => {
    preserveDraftForNextKeyRef.current = false;
    if (sourceDraftKey !== null) {
      try {
        await draftStore.transition(
          sourceDraftKey,
          draftKeyRef.current ?? sourceDraftKey,
          null,
        );
        setDraftPersistenceError(null);
      } catch {
        setDraftPersistenceError(cleanupError);
      }
    }
    resetComposerContent(
      { text: "", tokens: [] },
      collapsedSelection(0),
    );
    setAttachments([]);
    setSelectedTokenIndex(null);
    setTrigger(null);
    setMarkdownPreview(false);
  };

  const send = async () => {
    if (!canSend || sendingRef.current) {
      return;
    }
    const sourceDraftKey = draftKey;
    preserveDraftForNextKeyRef.current = false;
    sendingRef.current = true;
    if (shellMode) {
      if (showProjectPicker) preserveDraftForNextKeyRef.current = true;
      try {
        if (await onRunShellCommand(shellCommand, turnConfiguration())) {
          await clearSubmittedDraft(
            sourceDraftKey,
            "Shell 命令已提交，但草稿清理失败",
          );
        } else if (showProjectPicker) {
          releaseDraftPreservationIfUnchanged();
        }
      } finally {
        sendingRef.current = false;
      }
      return;
    }
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
        setAttachments((current) =>
          current.map((attachment) =>
            failed.has(attachment.id)
              ? {
                  ...attachment,
                  blob: null,
                  error: "无法读取此图片",
                  status: "error",
                }
              : attachment)
        );
        return;
      }
      const input: TurnStartParams["input"] = [
        ...(normalized.length === 0 ? [] : [{ type: "text" as const, text: normalized }]),
        ...tokens,
        ...prepared.flatMap(({ url }) =>
          url === null ? [] : [{ type: "image" as const, url }],
        ),
      ];
      if (showProjectPicker) preserveDraftForNextKeyRef.current = true;
      if (await onSend(input, turnConfiguration())) {
        await clearSubmittedDraft(
          sourceDraftKey,
          "消息已发送，但草稿清理失败",
        );
      } else if (showProjectPicker) {
        releaseDraftPreservationIfUnchanged();
      }
    } finally {
      sendingRef.current = false;
      setPreparingAttachments(false);
    }
  };

  const updateTrigger = (value: string, cursor: number, composing = false) => {
    setTrigger(
      composing || value.startsWith("!")
        ? null
        : findTrigger(value, cursor),
    );
  };

  const focusComposerSelection = (selection: ComposerSelection) => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea === null || textarea.disabled) return;
      textarea.focus();
      textarea.setSelectionRange(selection.start, selection.end, selection.direction);
    });
  };

  const restoreComposerSnapshot = (
    snapshot: ComposerHistorySnapshot<ComposerContent> | null,
  ) => {
    if (snapshot === null) return;
    setSelectedTokenIndex(null);
    updateTrigger(snapshot.value.text, snapshot.selection.start);
    focusComposerSelection(snapshot.selection);
  };

  const performComposerHistoryAction = (action: "undo" | "redo") => {
    restoreComposerSnapshot(
      action === "undo" ? undoComposerContent() : redoComposerContent(),
    );
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    const selection = selectionFromTextarea(event.target);
    const merge = composerHistoryMerge(event.nativeEvent);
    changeComposerContent(
      (current) => ({ ...current, text: value }),
      selection,
      merge?.key ?? null,
      merge?.windowMs,
    );
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
      const next = replaceTrigger(text, trigger, "");
      const nextSelection = collapsedSelection(trigger.start);
      if (command.behavior === "compact" || command.behavior === "review") {
        changeComposerContent(
          (current) => ({ ...current, text: next }),
          nextSelection,
        );
        setTrigger(null);
        await onRunImmediateCommand?.(command.behavior);
      } else if (command.behavior === "attach") {
        changeComposerContent(
          (current) => ({ ...current, text: next }),
          nextSelection,
        );
        setTrigger(null);
        attachmentInputRef.current?.click();
      } else if (command.behavior === "settings") {
        changeComposerContent(
          (current) => ({ ...current, text: next }),
          nextSelection,
        );
        setTrigger(null);
        onOpenSettings?.();
      } else if (command.behavior === "insert") {
        const replacement = `/${command.name}${keepTyping ? " " : " "}`;
        const inserted = replaceTrigger(text, trigger, replacement);
        const cursor = trigger.start + replacement.length;
        changeComposerContent(
          (current) => ({ ...current, text: inserted }),
          collapsedSelection(cursor),
        );
        setTrigger(null);
        focusAt(textareaRef.current, cursor);
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
    const cursor = trigger.start + replacement.length;
    changeComposerContent(
      (current) => ({
        ...current,
        text: next,
        tokens: [...current.tokens, nextToken],
      }),
      collapsedSelection(cursor),
    );
    setTrigger(null);
    focusAt(textareaRef.current, cursor);
  };

  const handleBeforeInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const action = composerHistoryInputAction(event.nativeEvent);
    if (action === null) return;
    event.preventDefault();
    performComposerHistoryAction(action);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    const historyAction = composerHistoryKeyboardAction(event);
    if (historyAction !== null) {
      event.preventDefault();
      performComposerHistoryAction(historyAction);
      return;
    }
    if (event.key === "Backspace" && text.length === 0 && tokens.length > 0) {
      event.preventDefault();
      const lastIndex = tokens.length - 1;
      if (selectedTokenIndex === lastIndex) {
        changeComposerContent(
          (current) => ({ ...current, tokens: current.tokens.slice(0, -1) }),
          getComposerSelection(),
        );
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
    rememberComposerHistorySelection(selectionFromTextarea(textarea));
  };

  const restoreComposerSelection = () => {
    focusComposerSelection(getComposerSelection());
  };

  const openSavedPromptPicker = () => {
    rememberComposerSelection();
    setMenuOpen(false);
    setSavedPromptManagerOpen(false);
    setSavedPromptPickerOpen(true);
    setSavedPromptQuery("");
    setSavedPromptActionError(null);
    savedPrompts.clearError();
    void savedPrompts.reload();
  };

  const openSavedPromptManager = (startCreating = false) => {
    setMenuOpen(false);
    setSavedPromptPickerOpen(false);
    setSavedPromptManagerCreate(startCreating);
    setSavedPromptManagerOpen(true);
    setSavedPromptActionError(null);
    void savedPrompts.reload();
  };

  const copySavedPrompt = async (prompt: SavedPrompt) => {
    setSavedPromptActionError(null);
    try {
      await navigator.clipboard.writeText(prompt.content);
      setCopiedPromptId(prompt.promptId);
      if (copiedPromptTimeoutRef.current !== null) {
        window.clearTimeout(copiedPromptTimeoutRef.current);
      }
      copiedPromptTimeoutRef.current = window.setTimeout(() => {
        setCopiedPromptId(null);
        copiedPromptTimeoutRef.current = null;
      }, 1_500);
    } catch {
      setSavedPromptActionError("未能复制常用提示词");
    }
  };

  const sendSavedPrompt = async (prompt: SavedPrompt) => {
    if (
      sendingRef.current ||
      submitting ||
      stopping ||
      preparingAttachments ||
      shellCommandActive
    ) return;
    sendingRef.current = true;
    setSendingPromptId(prompt.promptId);
    setSavedPromptActionError(null);
    if (showProjectPicker) preserveDraftForNextKeyRef.current = true;
    try {
      const sent = await onSend(
        [{ type: "text", text: prompt.content }],
        turnConfiguration(),
      );
      if (sent) {
        setSavedPromptPickerOpen(false);
      } else {
        if (showProjectPicker) releaseDraftPreservationIfUnchanged();
        setSavedPromptActionError("未能发送常用提示词，当前草稿未受影响");
      }
    } finally {
      sendingRef.current = false;
      setSendingPromptId(null);
      restoreComposerSelection();
    }
  };

  const triggerShellCommand = () => {
    if (text.length > 0 || tokens.length > 0 || attachments.length > 0) {
      return;
    }
    setMenuOpen(false);
    setMarkdownPreview(false);
    setTrigger(null);
    changeComposerContent(
      (current) => ({ ...current, text: "!" }),
      collapsedSelection(1),
    );
    focusAt(textareaRef.current, 1);
  };

  const triggerMention = () => {
    setMenuOpen(false);
    const textarea = textareaRef.current;
    if (!textarea) return;

    const value = text;
    const cursor = textarea.selectionStart ?? value.length;

    const newValue = value.slice(0, cursor) + "@" + value.slice(textarea.selectionEnd ?? cursor);
    const newCursor = cursor + 1;
    changeComposerContent(
      (current) => ({ ...current, text: newValue }),
      collapsedSelection(newCursor),
    );

    textarea.focus();
    setTimeout(() => {
      textarea.selectionStart = newCursor;
      textarea.selectionEnd = newCursor;
      updateTrigger(newValue, newCursor);
    }, 0);
  };

  const prepareQueuedFiles = async (
    queued: readonly { readonly file: File; readonly attachment: DraftAttachment }[],
  ) => {
    const prepared = await Promise.all(queued.map(({ attachment, file }) =>
      readAttachment(file, attachment, imageValidator)
    ));
    const preparedById = new Map(prepared.map((attachment) => [attachment.id, attachment]));
    setAttachments((current) =>
      current.map((attachment) => preparedById.get(attachment.id) ?? attachment)
    );
  };

  const addFiles = async (
    files: FileList | readonly File[],
    source: AttachmentSource,
  ) => {
    setClipboardReadError(null);
    const queued = [...files].map((file, index) => ({
      file,
      attachment: pendingAttachment(file, source, index),
    }));
    if (queued.length === 0) return;
    setAttachments((current) => [
      ...current,
      ...queued.map(({ attachment }) => attachment),
    ]);
    await prepareQueuedFiles(queued);
  };

  const finishClipboardFileRead = (request: number) => {
    if (request !== clipboardReadRequestRef.current) return;
    readingClipboardFilesRef.current = false;
    setReadingClipboardFiles(false);
  };

  const addClipboardFiles = async (reportEmpty: boolean) => {
    if (readingClipboardFilesRef.current) return;
    readingClipboardFilesRef.current = true;
    const request = ++clipboardReadRequestRef.current;
    setReadingClipboardFiles(true);
    setClipboardReadError(null);

    let results: readonly ClipboardFileResult[];
    try {
      results = await clipboardFilesReader();
    } catch {
      if (request !== clipboardReadRequestRef.current) return;
      setClipboardReadError("无法读取系统剪贴板");
      finishClipboardFileRead(request);
      return;
    }
    if (request !== clipboardReadRequestRef.current) return;
    if (results.length === 0) {
      if (reportEmpty) {
        setClipboardReadError("剪贴板中没有可读取的图片");
      }
      finishClipboardFileRead(request);
      return;
    }

    const queued = results.flatMap((result, index) => result.file === null
      ? []
      : [{
          file: result.file,
          attachment: pendingAttachment(result.file, "paste", index),
        }]
    );
    const queuedByResult = new Map(queued.map((item) => [item.file, item.attachment]));
    const additions = results.map((result) => {
      if (result.file !== null) {
        return queuedByResult.get(result.file)!;
      }
      return {
        id: crypto.randomUUID(),
        name: result.name,
        size: result.size,
        blob: null,
        error: result.error,
        status: "error" as const,
      };
    });
    setAttachments((current) => [...current, ...additions]);
    finishClipboardFileRead(request);
    await prepareQueuedFiles(queued);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    setClipboardReadError(null);
    const files = clipboardFiles(event.clipboardData);
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files, "paste");
      return;
    }
    if (clipboardContainsLocalFileUris(event.clipboardData)) {
      event.preventDefault();
      void addClipboardFiles(true);
      return;
    }
    if (event.clipboardData.getData("text/plain").length > 0) {
      return;
    }
    const types = Array.from(event.clipboardData.types ?? []);
    const items = Array.from(event.clipboardData.items ?? []);
    if (
      types.some((type) => type.startsWith("image/"))
      || (types.length === 0 && items.length === 0)
    ) {
      void addClipboardFiles(types.some((type) => type.startsWith("image/")));
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (preparingAttachments || submitting) {
      return;
    }
    if (event.dataTransfer.files.length > 0) {
      void addFiles(event.dataTransfer.files, "drop");
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
        textareaRef.current?.focus();
      }
    } catch {
      setCwdError("无法打开系统目录选择器");
      setEditingCwd(true);
    } finally {
      setPickingCwd(false);
    }
  };

  return (
    <section className={styles.composer} data-conversation-composer>
      {interactionPanel}
      {error === null ? null : <div className={styles.error} role="alert">{error}</div>}
      {draftPersistenceError === null
        ? null
        : <div className={styles.error} role="alert">{draftPersistenceError}</div>}
      {capabilitiesError === null ? null : <div className={styles.capabilityError} role="status">{capabilitiesError}</div>}
      {showProjectPicker || accessoryPanel !== undefined ? (
        <ComposerAccessoryPanel>
          {showProjectPicker ? (
            <ComposerAccessoryRow>
              <div className={styles.cwdControl}>
                <ProjectPicker
                  cwd={cwd}
                  directories={cwdOptions}
                  disabled={
                    onCwdChange === undefined ||
                    activeTurn ||
                    submitting ||
                    deletingProject
                  }
                  onBrowse={onPickCwd === undefined ? undefined : () => void chooseCwd()}
                  onCustom={() => {
                    setCwdInput(cwd ?? "");
                    setCwdError(null);
                    setEditingCwd(true);
                  }}
                  onDelete={onDeleteProject === undefined ? undefined : (directory) => {
                    setProjectDeleteError(null);
                    setProjectToDelete(directory);
                  }}
                  onSelect={(directory) => {
                    onCwdChange?.(directory);
                    textareaRef.current?.focus();
                  }}
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
            </ComposerAccessoryRow>
          ) : null}
          {accessoryPanel}
        </ComposerAccessoryPanel>
      ) : null}
      <div
        className={styles.surface}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        <button
          aria-label={markdownPreview ? "编辑 Markdown" : "预览 Markdown"}
          aria-pressed={markdownPreview}
          className={styles.markdownModeButton}
          disabled={shellMode || (!markdownPreview && normalized.length === 0)}
          onClick={() => {
            if (markdownPreview) {
              setMarkdownPreview(false);
              restoreComposerSelection();
            } else {
              const editorHeight = textareaRef.current?.getBoundingClientRect().height ?? 0;
              markdownPreviewHeightRef.current = editorHeight > 0 ? editorHeight : null;
              rememberComposerSelection();
              setTrigger(null);
              setMarkdownPreview(true);
            }
          }}
          onPointerDown={rememberComposerSelection}
          type="button"
        >
          {markdownPreview ? "编辑" : "预览"}
        </button>
        {trigger === null ? null : (
          <SuggestionMenu
            items={suggestions}
            menuKind={trigger.kind}
            onChoose={(item) => void chooseSuggestion(item, false)}
            onHover={setSelectedIndex}
            selectedIndex={selectedIndex}
          />
        )}
        {markdownPreview ? (
          <div
            aria-label="Markdown 预览"
            className={styles.markdownPreview}
            role="region"
            {...(markdownPreviewHeightRef.current === null
              ? {}
              : { style: { height: `${markdownPreviewHeightRef.current}px` } })}
          >
            <SafeMarkdown source={text} />
          </div>
        ) : (
          <textarea
            aria-label="任务输入"
            data-composer-input
            disabled={submitting || preparingAttachments}
            onBeforeInput={handleBeforeInput}
            onChange={handleChange}
            onClick={(event) => updateTrigger(text, event.currentTarget.selectionStart)}
            onCompositionStart={() => {
              composingRef.current = true;
              breakComposerHistoryMerge();
              setTrigger(null);
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              breakComposerHistoryMerge();
              updateTrigger(event.currentTarget.value, event.currentTarget.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={(event) => {
              if (
                !event.nativeEvent.isComposing
                && composerHistoryKeyboardAction(event) === null
                && !["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)
              ) {
                updateTrigger(text, event.currentTarget.selectionStart);
              }
            }}
            placeholder={
              shellCommandActive
                ? "Shell 命令执行完成后可发送消息"
                : activeTurn
                  ? "输入要追加的内容"
                  : "向 Codex 描述任务"
            }
            onPaste={handlePaste}
            onSelect={rememberComposerSelection}
            ref={textareaRef}
            rows={1}
            value={text}
          />
        )}
        <input
          accept={IMAGE_ACCEPT}
          aria-label="选择图片附件"
          className={styles.fileInput}
          disabled={submitting || preparingAttachments}
          multiple
          onChange={(event) => {
            if (event.target.files !== null) {
              void addFiles(event.target.files, "picker");
            }
            event.target.value = "";
          }}
          ref={attachmentInputRef}
          type="file"
        />
        {shellMode ? (
          <div
            className={styles.shellCommandStatus}
            data-error={hasShellIncompatibleContent}
            role={hasShellIncompatibleContent ? "alert" : "status"}
          >
            {hasShellIncompatibleContent
              ? "Shell 命令不能包含附件或结构化引用，请先移除"
              : "将在当前服务器直接执行，不受会话权限限制"}
          </div>
        ) : shellCommandActive && normalized.length > 0 ? (
          <div className={styles.shellCommandStatus} role="status">
            Shell 命令执行完成后可发送普通消息
          </div>
        ) : null}
        {readingClipboardFiles || clipboardReadError !== null ? (
          <div
            className={styles.clipboardStatus}
            data-error={clipboardReadError !== null}
            role="status"
          >
            {clipboardReadError ?? "正在读取剪贴板图片"}
          </div>
        ) : null}
        {attachments.length === 0 ? null : (
          <div aria-label="附件" className={styles.attachments}>
            {attachments.map((attachment) => (
              <article className={styles.attachmentCard} data-error={attachment.status === "error"} key={attachment.id}>
                <AttachmentThumbnail attachment={attachment} blobUrlFactory={blobUrlFactory} />
                <span>
                  <strong>{attachment.name}</strong>
                  <small>
                    {attachment.status === "preparing"
                      ? "正在读取图片"
                      : attachment.error
                        ?? (selectedModelRejectsImages
                          ? "当前模型不支持图片输入"
                          : formatFileSize(attachment.size))}
                  </small>
                </span>
                <button
                  aria-label={`移除 ${attachment.name}`}
                  disabled={preparingAttachments || submitting}
                  onClick={() => setAttachments((current) =>
                    current.filter(({ id }) => id !== attachment.id)
                  )}
                  type="button"
                >
                  ×
                </button>
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
                <button
                  aria-label={`移除 ${token.name}`}
                  onClick={() => changeComposerContent(
                    (current) => ({
                      ...current,
                      tokens: current.tokens.filter((_, itemIndex) => itemIndex !== index),
                    }),
                    getComposerSelection(),
                  )}
                  type="button"
                >
                  ×
                </button>
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
                    disabled={
                      text.length > 0 ||
                      tokens.length > 0 ||
                      attachments.length > 0
                    }
                    onClick={triggerShellCommand}
                    role="menuitem"
                    type="button"
                  >
                    <svg aria-hidden="true" className={styles.menuIcon} viewBox="0 0 24 24">
                      <path d="m5 7 5 5-5 5" />
                      <path d="M12 17h7" />
                    </svg>
                    <div className={styles.menuText}>
                      <strong>执行 Shell 命令</strong>
                      <small>
                        {text.length > 0 || tokens.length > 0 || attachments.length > 0
                          ? "请先清空当前输入"
                          : "在当前服务器无沙箱执行 (!)"}
                      </small>
                    </div>
                  </button>
                  <button
                    disabled={shellMode}
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
                    disabled={shellMode}
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
                    disabled={shellCommandActive}
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
                    {filteredSavedPrompts.map((prompt) => {
                      const copied = copiedPromptId === prompt.promptId;
                      return (
                        <div className={styles.savedPromptItem} key={prompt.promptId}>
                          <span>
                            <strong>{prompt.name}</strong>
                            <small>{prompt.content}</small>
                          </span>
                          <div className={styles.savedPromptActions}>
                            <button
                              aria-label={`复制 ${prompt.name}`}
                              className={styles.savedPromptAction}
                              onClick={() => void copySavedPrompt(prompt)}
                              type="button"
                            >
                              <svg aria-hidden="true" viewBox="0 0 24 24">
                                {copied ? (
                                  <path d="m6 12 4 4 8-9" />
                                ) : (
                                  <>
                                    <rect height="12" rx="2" width="12" x="8" y="8" />
                                    <path d="M16 6V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1" />
                                  </>
                                )}
                              </svg>
                              <span aria-hidden="true" className={styles.savedPromptActionTooltip}>
                                {copied ? "已复制" : "复制"}
                              </span>
                              <span aria-live="polite" className={styles.srOnly}>
                                {copied ? `${prompt.name} 已复制` : ""}
                              </span>
                            </button>
                            <button
                              aria-label={`发送 ${prompt.name}`}
                              className={styles.savedPromptAction}
                              disabled={
                                sendingPromptId !== null ||
                                submitting ||
                                stopping ||
                                shellCommandActive
                              }
                              onClick={() => void sendSavedPrompt(prompt)}
                              type="button"
                            >
                              <svg aria-hidden="true" viewBox="0 0 24 24">
                                <path d="m5 12 14-7-4 14-3-6Z" />
                                <path d="m12 13 7-8" />
                              </svg>
                              <span aria-hidden="true" className={styles.savedPromptActionTooltip}>发送</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {savedPrompts.error === null && savedPromptActionError === null ? null : (
                    <div className={styles.savedPromptError} role="alert">
                      {savedPromptActionError ?? savedPrompts.error}
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
              defaultPermission={defaultPermission}
              disabled={activeTurn || permissionsLoading}
              loading={permissionsLoading}
              onSelect={setSelectedPermission}
              permissions={permissions}
              selectedPermission={selectedPermission}
            />
          </div>
          <ModelPicker
            activeModel={activeModel}
            defaultEffort={defaultEffort}
            defaultModel={defaultModel}
            defaultModelId={defaultModelId}
            defaultModelSource={defaultModelSource}
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
          {fastTier === null ? null : (
            <button
              aria-checked={fastEnabled}
              aria-label="当前会话 Fast 模式"
              className={styles.fastToggle}
              data-active={fastEnabled}
              disabled={activeTurn || submitting || stopping || serviceTierUpdating}
              onClick={() => void toggleFast()}
              role="switch"
              title={`${fastTier.description} · 仅影响当前会话`}
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="m13.5 2-8 12h6l-1 8 8-12h-6Z" />
              </svg>
              <span>Fast</span>
            </button>
          )}
          <div className={styles.actions}>
            {activeTurn && (canSend || shellMode) ? (
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
            {activeTurn && !canSend && !shellMode ? (
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
                aria-label={
                  preparingAttachments || readingClipboardFiles
                    ? "正在准备"
                    : submitting
                      ? "正在提交"
                      : shellMode
                        ? "执行 Shell 命令"
                        : activeTurn
                          ? "追加"
                          : "发送"
                }
                className={styles.sendButton}
                disabled={!canSend}
                onClick={() => void send()}
                title={shellMode ? "执行 Shell 命令" : activeTurn ? "追加" : "发送"}
                type="button"
              >
                {shellMode ? (
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="m5 7 5 5-5 5" />
                    <path d="M12 17h7" />
                  </svg>
                ) : (
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />
                  </svg>
                )}
              </button>
            )}
          </div>
        </footer>
      </div>
      <ProjectDeleteDialog
        deleting={deletingProject}
        directory={projectToDelete}
        error={projectDeleteError}
        onCancel={() => {
          setProjectDeleteError(null);
          setProjectToDelete(null);
        }}
        onConfirm={(directory) => {
          if (onDeleteProject === undefined || deletingProject) {
            return;
          }
          setDeletingProject(true);
          setProjectDeleteError(null);
          void onDeleteProject(directory).then(
            () => {
              setProjectToDelete(null);
            },
            () => {
              setProjectDeleteError("无法删除受信任项目，请重试");
            },
          ).finally(() => {
            setDeletingProject(false);
          });
        }}
      />
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
  onDelete,
  onSelect,
  picking,
}: {
  readonly cwd: string | null;
  readonly directories: readonly string[];
  readonly disabled: boolean;
  readonly onBrowse: (() => void) | undefined;
  readonly onCustom: () => void;
  readonly onDelete: ((directory: string) => void) | undefined;
  readonly onSelect: (directory: string) => void;
  readonly picking: boolean;
}) {
  const menuId = useId();
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const focusedOptionRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filteredDirectories = useMemo(
    () => filterProjectDirectories(directories, query),
    [directories, query],
  );
  const selectedIndex = cwd === null ? -1 : filteredDirectories.indexOf(cwd);
  const [focusedIndex, setFocusedIndex] = useState(Math.max(0, selectedIndex));

  useEffect(() => {
    setFocusedIndex(Math.max(0, selectedIndex));
  }, [selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
      setQuery("");
    }
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    focusedOptionRef.current?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [focusedIndex, open]);

  useEffect(() => {
    if (disabled) {
      return;
    }
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key.toLowerCase() === "o" &&
        document.querySelector('[aria-modal="true"]') === null
      ) {
        event.preventDefault();
        setQuery("");
        setFocusedIndex(Math.max(0, cwd === null ? -1 : directories.indexOf(cwd)));
        setOpen(true);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [cwd, directories, disabled]);

  const close = (restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) triggerRef.current?.focus();
  };
  const openMenu = () => {
    setQuery("");
    setFocusedIndex(Math.max(0, cwd === null ? -1 : directories.indexOf(cwd)));
    setOpen(true);
  };

  const choose = (index: number) => {
    const directory = filteredDirectories[index];
    if (directory === undefined) return;
    onSelect(directory);
    close();
  };
  const move = (direction: 1 | -1) => {
    if (filteredDirectories.length === 0) return;
    setFocusedIndex((current) =>
      (current + direction + filteredDirectories.length) % filteredDirectories.length,
    );
  };

  return (
    <div className={styles.projectPicker} ref={containerRef}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="项目"
        disabled={disabled}
        onClick={() => {
          if (open) close();
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) openMenu();
            else move(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            choose(focusedIndex);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            close(true);
          }
        }}
        title={cwd ?? "选择服务器工作目录"}
        ref={triggerRef}
        type="button"
      >
        <svg aria-hidden="true" className={styles.projectIcon} viewBox="0 0 24 24">
          <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4l2 2h6A2.5 2.5 0 0 1 20.5 8.5v8A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z" />
        </svg>
        <span className={styles.projectName}>{cwd === null ? "选择项目" : projectName(cwd)}</span>
        <span aria-hidden="true" className={styles.projectChevron}>⌄</span>
      </button>
      {open ? (
        <div aria-label="项目设置" className={styles.projectMenu} id={menuId} role="dialog">
          <label className={styles.projectSearch}>
            <span aria-hidden="true">⌕</span>
            <input
              aria-controls={filteredDirectories.length === 0 ? undefined : listboxId}
              aria-label="搜索项目"
              onChange={(event) => {
                setQuery(event.target.value);
                setFocusedIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  move(event.key === "ArrowDown" ? 1 : -1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  choose(focusedIndex);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  close(true);
                }
              }}
              placeholder="搜索项目名称或路径"
              ref={searchRef}
              type="search"
              value={query}
            />
          </label>
          {directories.length === 0 ? (
            <p>尚无配置项目</p>
          ) : filteredDirectories.length === 0 ? (
            <p>未找到匹配项目</p>
          ) : (
            <div
              aria-label="选择项目"
              className={styles.projectOptions}
              id={listboxId}
              role="listbox"
            >
              {filteredDirectories.map((directory, index) => (
                <ProjectOption
                  directory={directory}
                  focused={index === focusedIndex}
                  key={directory}
                  onDelete={onDelete === undefined
                    ? undefined
                    : () => {
                        close();
                        onDelete(directory);
                      }}
                  onFocus={() => setFocusedIndex(index)}
                  onMouseMove={() => setFocusedIndex(index)}
                  onSelect={() => choose(index)}
                  optionRef={index === focusedIndex ? focusedOptionRef : undefined}
                  selected={directory === cwd}
                />
              ))}
            </div>
          )}
          <div className={styles.projectActions}>
            <button onClick={() => { close(); onCustom(); }} type="button">输入自定义目录…</button>
            {onBrowse === undefined ? null : (
              <button disabled={picking} onClick={() => { close(); onBrowse(); }} type="button">
                {picking ? "正在选择…" : "浏览本地目录…"}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ProjectOption({
  directory,
  focused,
  onDelete,
  onFocus,
  onMouseMove,
  onSelect,
  optionRef,
  selected,
}: {
  readonly directory: string;
  readonly focused: boolean;
  readonly onDelete: (() => void) | undefined;
  readonly onFocus: () => void;
  readonly onMouseMove: () => void;
  readonly onSelect: () => void;
  readonly optionRef: Ref<HTMLDivElement> | undefined;
  readonly selected: boolean;
}) {
  const name = projectName(directory);
  const tooltipId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const [nameTruncated, setNameTruncated] = useState(false);
  const [showFullName, setShowFullName] = useState(false);

  useEffect(() => {
    const element = nameRef.current;
    if (element === null) {
      return;
    }
    const measure = () => {
      const truncated = element.scrollWidth > element.clientWidth;
      setNameTruncated((current) => current === truncated ? current : truncated);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [name]);

  const tooltipVisible = nameTruncated && showFullName;
  return (
    <div
      data-focused={focused}
      data-selected={selected}
      onMouseEnter={() => setShowFullName(true)}
      onMouseLeave={() => setShowFullName(false)}
      onMouseMove={onMouseMove}
      ref={optionRef}
      role="presentation"
    >
      <button
        aria-describedby={tooltipVisible ? tooltipId : undefined}
        aria-selected={selected}
        className={styles.projectOptionSelect}
        onBlur={() => setShowFullName(false)}
        onClick={onSelect}
        onFocus={() => {
          onFocus();
          setShowFullName(true);
        }}
        ref={buttonRef}
        role="option"
        type="button"
      >
        <strong>
          {selected ? <span aria-hidden="true">✓&nbsp;</span> : null}
          <span
            className={styles.projectOptionName}
            data-project-option-name
            data-truncated={nameTruncated}
            ref={nameRef}
          >
            {name}
          </span>
        </strong>
        <small>{directory}</small>
      </button>
      {onDelete === undefined ? null : (
        <button
          aria-label={`删除项目 ${name}`}
          className={styles.projectOptionDelete}
          onClick={onDelete}
          title="删除受信任项目"
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M4.5 7h15M9.5 3.5h5L16 7H8zM7 7l.8 13h8.4L17 7M10 10.5v6M14 10.5v6" />
          </svg>
        </button>
      )}
      {tooltipVisible && buttonRef.current !== null
        ? createPortal(
            <span
              className={styles.projectNameTooltip}
              id={tooltipId}
              role="tooltip"
              style={projectNameTooltipPosition(buttonRef.current)}
            >
              {name}
            </span>,
            document.body,
          )
        : null}
    </div>
  );
}

function projectNameTooltipPosition(element: HTMLElement): CSSProperties {
  const bounds = element.getBoundingClientRect();
  const width = Math.min(340, window.innerWidth - 16);
  return {
    left: Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8)),
    top: Math.min(bounds.bottom + 4, window.innerHeight - 48),
    width,
  };
}

function findFastServiceTier(model: Model | null) {
  return model?.serviceTiers?.find(
    ({ name }) => name.trim().toLocaleLowerCase() === "fast",
  ) ?? null;
}

function isFastServiceTier(
  serviceTier: string | null,
  knownFastServiceTiers: ReadonlySet<string>,
): boolean {
  return serviceTier !== null && knownFastServiceTiers.has(serviceTier);
}

function ModelPicker({
  activeModel,
  defaultEffort,
  defaultModel,
  defaultModelId,
  defaultModelSource,
  disabled,
  loading,
  models,
  onSelectEffort,
  onSelectModel,
  selectedEffort,
  selectedModel,
}: {
  readonly activeModel: Model | null;
  readonly defaultEffort: string | null;
  readonly defaultModel: Model | null;
  readonly defaultModelId: string | null;
  readonly defaultModelSource: "catalog" | "config" | "thread";
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
  const visibleModels = useMemo(
    () => models.filter(({ hidden }) => !hidden),
    [models],
  );

  useEffect(() => {
    const selectedIndex = visibleModels.findIndex(({ model }) => model === selectedModel);
    setFocusedIndex(selectedModel === null || selectedIndex < 0 ? 0 : selectedIndex + 1);
  }, [selectedModel, visibleModels]);

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
      const model = visibleModels[index - 1];
      if (model === undefined) return;
      onSelectModel(model.model);
    }
    setFocusedIndex(index);
    setOpen(false);
  };
  const move = (direction: 1 | -1) => {
    const optionCount = visibleModels.length + 1;
    setFocusedIndex((current) =>
      (current + direction + optionCount) % optionCount,
    );
  };
  const displayedEffort = selectedEffort
    ?? defaultEffort
    ?? activeModel?.defaultReasoningEffort
    ?? null;
  const effortDescription = activeModel?.supportedReasoningEfforts.find(
    ({ reasoningEffort }) => reasoningEffort === displayedEffort,
  )?.description;
  const defaultLabel = defaultModelSource === "config"
    ? "配置"
    : defaultModelSource === "thread" ? "会话" : "默认";
  const defaultOptionLabel = defaultModelSource === "config"
    ? "目录配置"
    : defaultModelSource === "thread" ? "当前会话" : "服务器默认";
  const activeModelLabel = activeModel?.displayName
    ?? (selectedModel ?? defaultModelId);
  const modelLabel = loading && selectedModel === null
    ? "加载模型"
    : activeModelLabel === null
      ? "服务器默认模型"
      : `${selectedModel === null ? `${defaultLabel} · ` : ""}${activeModelLabel}`;
  const effortLabel = displayedEffort === null
    ? ""
    : ` · ${selectedEffort === null && selectedModel !== null
      ? `${defaultEffort === null ? "默认" : defaultLabel} `
      : ""}${displayedEffort}`;

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
          : `${selectedModel === null ? `${defaultOptionLabel} · ` : ""}${activeModel.description}${displayedEffort === null ? "" : ` · 思考程度 ${displayedEffort}`}`}
        type="button"
      >
        {modelLabel}{effortLabel}
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
                <strong>
                  {selectedModel === null ? "✓ " : ""}{defaultOptionLabel}
                  {defaultModel === null
                    ? defaultModelId === null ? "" : ` · ${defaultModelId}`
                    : ` · ${defaultModel.displayName}`}
                </strong>
              </span>
              <small>不覆盖服务器的模型与思考程度配置</small>
            </button>
            {visibleModels.map((model, index) => (
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
                <option value="">
                  {defaultEffort === null
                    ? `服务器默认 · ${activeModel.defaultReasoningEffort}`
                    : `${defaultOptionLabel} · ${defaultEffort}`}
                </option>
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
  defaultPermission,
  disabled,
  loading,
  onSelect,
  permissions,
  selectedPermission,
}: {
  readonly defaultPermission: string | null;
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
    () => [{
      id: null,
      allowed: true,
      description: defaultPermission === null
        ? "使用服务器默认审批、沙箱和网络策略"
        : `使用服务器明确配置的默认权限：${permissionTitle(defaultPermission)}`,
    } as const, ...permissions],
    [defaultPermission, permissions],
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
        {loading
          ? "加载权限"
          : selectedPermission === null
            ? defaultPermissionTitle(defaultPermission)
            : permissionTitle(selectedPermission)}
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
                <span><strong>{option.id === selectedPermission ? "✓ " : ""}{option.id === null ? defaultPermissionTitle(defaultPermission) : permissionTitle(option.id)}</strong>{presentation.risk === "high" ? <small>高风险</small> : null}</span>
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

function filterProjectDirectories(
  directories: readonly string[],
  query: string,
): readonly string[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) return directories;
  return directories.filter((directory) => {
    const normalizedDirectory = directory.toLocaleLowerCase();
    const normalizedName = projectName(directory).toLocaleLowerCase();
    return normalizedName.includes(normalizedQuery) ||
      normalizedDirectory.includes(normalizedQuery);
  });
}

function permissionTitle(id: string | null): string {
  if (id === null) return "默认权限";
  if (id === ":read-only") return "只读";
  if (id === ":workspace") return "工作区写入";
  if (id === ":danger-full-access") return "完全访问";
  return id;
}

function defaultPermissionTitle(defaultPermission: string | null): string {
  return defaultPermission === null
    ? "默认权限"
    : `默认 · ${permissionTitle(defaultPermission)}`;
}

function permissionPresentation(
  id: string | null,
  serverDescription?: string | null,
): { readonly description: string; readonly risk: "normal" | "high" } {
  if (id === null) return {
    description: serverDescription ?? "使用服务器默认审批、沙箱和网络策略",
    risk: "normal",
  };
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

function composerContentsEqual(left: ComposerContent, right: ComposerContent): boolean {
  return left.text === right.text
    && left.tokens === right.tokens;
}

function collapsedSelection(position: number): ComposerSelection {
  return { start: position, end: position, direction: "none" };
}

function selectionFromTextarea(textarea: HTMLTextAreaElement): ComposerSelection {
  return {
    start: textarea.selectionStart,
    end: textarea.selectionEnd,
    direction: textarea.selectionDirection ?? "none",
  };
}

function composerHistoryKeyboardAction(
  event: KeyboardEvent<HTMLElement>,
): "undo" | "redo" | null {
  if (!event.ctrlKey || event.altKey || event.metaKey) {
    return null;
  }
  const key = event.key.toLocaleLowerCase();
  if (key === "z") {
    return event.shiftKey ? "redo" : "undo";
  }
  if (key === "y" && !event.shiftKey) {
    return "redo";
  }
  return null;
}

function composerHistoryInputAction(event: Event): "undo" | "redo" | null {
  const inputType = eventInputType(event);
  if (inputType === "historyUndo") return "undo";
  if (inputType === "historyRedo") return "redo";
  return null;
}

function composerHistoryMerge(
  event: Event,
): { readonly key: string; readonly windowMs: number } | null {
  if (isComposingEvent(event)) {
    return { key: "composition", windowMs: Number.POSITIVE_INFINITY };
  }
  const inputType = eventInputType(event);
  if (inputType === "insertText") {
    return { key: inputType, windowMs: 1_000 };
  }
  if (inputType === "deleteContentBackward" || inputType === "deleteContentForward") {
    return { key: inputType, windowMs: 1_000 };
  }
  return null;
}

function eventInputType(event: Event): string | null {
  if (!("inputType" in event) || typeof event.inputType !== "string") {
    return null;
  }
  return event.inputType;
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

function pendingAttachment(
  file: File,
  source: AttachmentSource,
  index: number,
): DraftAttachment {
  return {
    id: crypto.randomUUID(),
    name: file.name || (source === "paste"
      ? `粘贴图片${index === 0 ? "" : ` ${index + 1}`}`
      : "未命名图片"),
    size: file.size,
    blob: null,
    error: null,
    status: "preparing",
  };
}

function clipboardFiles(clipboardData: DataTransfer): readonly File[] {
  const directFiles = Array.from(clipboardData.files ?? []);
  if (directFiles.length > 0) {
    return directFiles;
  }
  return Array.from(clipboardData.items ?? [])
    .filter(({ kind }) => kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function clipboardContainsLocalFileUris(clipboardData: DataTransfer): boolean {
  if (typeof clipboardData.getData !== "function") return false;
  const types = new Set(clipboardData.types ?? []);
  return ["text/uri-list", "x-special/gnome-copied-files"]
    .filter((type) => types.has(type))
    .some((type) => clipboardData.getData(type)
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) =>
        line.length > 0
        && !line.startsWith("#")
        && line !== "copy"
        && line !== "cut"
      )
      .some((line) => {
        try {
          return new URL(line).protocol === "file:";
        } catch {
          return false;
        }
      }));
}

async function readAttachment(
  file: File,
  pending: DraftAttachment,
  validateImage: ImageValidator,
): Promise<DraftAttachment> {
  if (file.size > MAX_IMAGE_SIZE) {
    return attachmentError(pending, "图片超过 16 MiB 上限");
  }
  try {
    const detectedType = await detectSupportedImageType(file);
    if (detectedType === null) {
      return attachmentError(
        pending,
        file.type.startsWith("image/")
          ? "不支持或无法识别此图片格式"
          : "当前服务器输入仅支持图片附件",
      );
    }
    const blob = file.type === detectedType
      ? file
      : new Blob([file], { type: detectedType });
    await validateImage(blob);
    return {
      ...pending,
      name: file.name || `${pending.name}.${extensionForImageType(detectedType)}`,
      blob,
      error: null,
      status: "ready",
    };
  } catch {
    return attachmentError(pending, "图片内容无效或无法解码");
  }
}

function attachmentError(
  pending: DraftAttachment,
  error: string,
): DraftAttachment {
  return { ...pending, blob: null, error, status: "error" };
}

async function detectSupportedImageType(
  file: Blob,
): Promise<SupportedImageType | null> {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  const header = new TextDecoder("ascii").decode(bytes);
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

function extensionForImageType(type: SupportedImageType): string {
  switch (type) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
  }
}

async function validateBrowserImage(blob: Blob): Promise<void> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    try {
      if (bitmap.width === 0 || bitmap.height === 0) {
        throw new TypeError("empty image");
      }
    } finally {
      bitmap.close();
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (image.naturalWidth === 0 || image.naturalHeight === 0) {
      throw new TypeError("empty image");
    }
  } finally {
    URL.revokeObjectURL(url);
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
  if (attachment.status === "preparing") {
    return <span aria-hidden="true" className={styles.attachmentPlaceholder}>…</span>;
  }
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
