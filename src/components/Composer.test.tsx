import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer";
import {
  createDraftStore,
  type DraftStore,
  type StoredDraft,
} from "../transport/drafts";
import type { SavedPrompt, SavedPromptStore } from "../transport/savedPrompts";
import type { TauriIpc } from "../transport/tauriIpc";

const SAVED_PROMPT: SavedPrompt = {
  promptId: "11111111-1111-4111-8111-111111111111",
  name: "代码审查",
  content: "  审查当前修改  ",
  version: 1,
  createdAtMs: 1,
  updatedAtMs: 1,
};

function savedPromptStore(initial: readonly SavedPrompt[] = [SAVED_PROMPT]): SavedPromptStore {
  let prompts = [...initial];
  return {
    list: vi.fn(async () => prompts),
    create: vi.fn(async (draft) => {
      const prompt: SavedPrompt = {
        promptId: `11111111-1111-4111-8111-${String(prompts.length + 2).padStart(12, "0")}`,
        ...draft,
        version: 1,
        createdAtMs: prompts.length + 2,
        updatedAtMs: prompts.length + 2,
      };
      prompts = [...prompts, prompt];
      return prompt;
    }),
    update: vi.fn(async (prompt, draft) => {
      const updated = { ...prompt, ...draft, version: prompt.version + 1 };
      prompts = prompts.map((current) => current.promptId === prompt.promptId ? updated : current);
      return updated;
    }),
    delete: vi.fn(async (prompt) => {
      prompts = prompts.filter((current) => current.promptId !== prompt.promptId);
    }),
    reorder: vi.fn(async (promptIds: readonly string[]) => {
      const byId = new Map(prompts.map((prompt) => [prompt.promptId, prompt]));
      prompts = promptIds.map((promptId) => byId.get(promptId)!);
    }),
  };
}

function deferred<Value = void>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function imageFile(
  name: string,
  type: "image/gif" | "image/jpeg" | "image/png" | "image/webp" = "image/png",
): File {
  const bytes = type === "image/png"
    ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    : type === "image/jpeg"
      ? [0xff, 0xd8, 0xff]
      : type === "image/gif"
        ? [...new TextEncoder().encode("GIF89a")]
        : [...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP")];
  return new File([new Uint8Array(bytes)], name, { type });
}

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const onRunShellCommand = vi.fn(async () => true);
  const onSend = vi.fn(async () => true);
  const onStop = vi.fn(async () => true);
  let blobUrlIndex = 0;
  const blobUrlFactory = {
    create: vi.fn(() => `blob:attachment-${blobUrlIndex++}`),
    revoke: vi.fn(),
  };
  const result = render(
    <Composer
      activeTurn={false}
      blobUrlFactory={blobUrlFactory}
      cwd="/workspace/project"
      error={null}
      imageValidator={async () => undefined}
      onRunShellCommand={onRunShellCommand}
      onSend={onSend}
      onStop={onStop}
      showProjectPicker={true}
      stopping={false}
      submitting={false}
      {...overrides}
    />,
  );
  return {
    blobUrlFactory,
    onRunShellCommand,
    onSend,
    onStop,
    unmount: result.unmount,
  };
}

describe("Composer", () => {
  it("从 SQLite 草稿存储恢复并在停止输入后保存", async () => {
    const user = userEvent.setup();
    const draftStore = {
      listKeys: vi.fn(async () => []),
      load: vi.fn(async () => ({
        text: "恢复内容",
        tokens: [{ type: "mention" as const, name: "README", path: "/workspace/README.md" }],
      })),
      save: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      transition: vi.fn(async () => undefined),
    };
    renderComposer({ draftKey: "window:server:draft", draftStore });

    await waitFor(() => expect(screen.getByRole("textbox", { name: "任务输入" })).toHaveValue("恢复内容"));
    expect(screen.getByLabelText("结构化输入")).toHaveTextContent("@README");
    await user.type(screen.getByRole("textbox", { name: "任务输入" }), "继续");
    await waitFor(() => expect(draftStore.save).toHaveBeenCalledWith(
      "window:server:draft",
      {
        text: "恢复内容继续",
        tokens: [{ type: "mention", name: "README", path: "/workspace/README.md" }],
      },
    ), { timeout: 1_500 });
  });

  it("切换草稿键时保存并恢复各自内容", async () => {
    const drafts = new Map<string, StoredDraft>([
      ["tab:a", { text: "草稿 A", tokens: [] }],
      ["tab:b", { text: "草稿 B", tokens: [] }],
    ]);
    const draftStore: DraftStore = {
      listKeys: vi.fn(async () => [...drafts.keys()]),
      load: vi.fn(async (draftKey) => drafts.get(draftKey) ?? null),
      save: vi.fn(async (draftKey, draft) => {
        drafts.set(draftKey, draft);
      }),
      delete: vi.fn(async (draftKey) => {
        drafts.delete(draftKey);
      }),
      transition: vi.fn(async () => undefined),
    };

    function Harness() {
      const [draftKey, setDraftKey] = useState("tab:a");
      return (
        <>
          <button onClick={() => setDraftKey("tab:a")} type="button">
            标签 A
          </button>
          <button onClick={() => setDraftKey("tab:b")} type="button">
            标签 B
          </button>
          <Composer
            activeTurn={false}
            cwd="/workspace/project"
            draftKey={draftKey}
            draftStore={draftStore}
            error={null}
            onRunShellCommand={async () => true}
            onSend={async () => true}
            onStop={async () => true}
            showProjectPicker
            stopping={false}
            submitting={false}
          />
        </>
      );
    }

    render(<Harness />);
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "任务输入",
    });
    await waitFor(() => expect(editor).toHaveValue("草稿 A"));

    fireEvent.change(editor, { target: { value: "修改后的草稿 A" } });
    fireEvent.click(screen.getByRole("button", { name: "标签 B" }));
    await waitFor(() => expect(draftStore.save).toHaveBeenCalledWith(
      "tab:a",
      { text: "修改后的草稿 A", tokens: [] },
    ));
    await waitFor(() => expect(editor).toHaveValue("草稿 B"));

    fireEvent.change(editor, { target: { value: "修改后的草稿 B" } });
    fireEvent.click(screen.getByRole("button", { name: "标签 A" }));
    await waitFor(() => expect(draftStore.save).toHaveBeenCalledWith(
      "tab:b",
      { text: "修改后的草稿 B", tokens: [] },
    ));
    await waitFor(() => expect(editor).toHaveValue("修改后的草稿 A"));

    fireEvent.click(screen.getByRole("button", { name: "标签 B" }));
    await waitFor(() => expect(editor).toHaveValue("修改后的草稿 B"));
  });

  it("Enter 发送成功后清空，Shift+Enter 保留换行", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "任务输入" });
    await user.type(editor, "第一行{shift>}{enter}{/shift}第二行");
    expect(editor).toHaveValue("第一行\n第二行");

    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "text", text: "第一行\n第二行" }],
      { cwd: "/workspace/project" },
    ));
    await waitFor(() => expect(editor).toHaveValue(""));
    fireEvent.keyDown(editor, { ctrlKey: true, key: "z" });
    expect(editor).toHaveValue("");
  });

  it("在保留 Markdown 源文和选区的前提下切换安全预览", async () => {
    const user = userEvent.setup();
    renderComposer();
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "任务输入" });
    fireEvent.change(editor, {
      target: { value: "# 标题\n\n**重点** [链接](https://example.com)" },
    });
    editor.setSelectionRange(3, 5, "forward");
    fireEvent.select(editor);

    await user.click(screen.getByRole("button", { name: "预览 Markdown" }));

    expect(screen.queryByRole("textbox", { name: "任务输入" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Markdown 预览" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "标题" })).toBeVisible();
    expect(screen.getByText("重点")).toBeVisible();
    expect(screen.queryByRole("button", { name: "链接" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑 Markdown" }));

    const restoredEditor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "任务输入" });
    expect(restoredEditor).toHaveValue("# 标题\n\n**重点** [链接](https://example.com)");
    await waitFor(() => expect(restoredEditor).toHaveFocus());
    expect(restoredEditor.selectionStart).toBe(3);
    expect(restoredEditor.selectionEnd).toBe(5);
  });

  it("通过常用快捷键撤销和重做连续文本输入", async () => {
    const user = userEvent.setup();
    renderComposer();
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "任务输入" });

    await user.type(editor, "连续输入");
    fireEvent.keyDown(editor, { ctrlKey: true, key: "z" });
    expect(editor).toHaveValue("");

    fireEvent.keyDown(editor, { ctrlKey: true, key: "y" });
    expect(editor).toHaveValue("连续输入");

    fireEvent.keyDown(editor, { ctrlKey: true, key: "z" });
    fireEvent.keyDown(editor, { ctrlKey: true, key: "Z", shiftKey: true });
    expect(editor).toHaveValue("连续输入");
  });

  it("撤销和重做文本编辑时恢复对应选区", async () => {
    const user = userEvent.setup();
    renderComposer();
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "任务输入" });

    await user.type(editor, "abcdef");
    editor.setSelectionRange(2, 4, "forward");
    fireEvent.select(editor);
    await user.keyboard("{Backspace}");
    expect(editor).toHaveValue("abef");

    fireEvent.keyDown(editor, { ctrlKey: true, key: "z" });
    expect(editor).toHaveValue("abcdef");
    await waitFor(() => {
      expect(editor.selectionStart).toBe(2);
      expect(editor.selectionEnd).toBe(4);
    });

    fireEvent.keyDown(editor, { ctrlKey: true, key: "Z", shiftKey: true });
    expect(editor).toHaveValue("abef");
    await waitFor(() => {
      expect(editor.selectionStart).toBe(2);
      expect(editor.selectionEnd).toBe(2);
    });
  });

  it("撤销和重做结构化令牌时不改变附件", async () => {
    const user = userEvent.setup();
    renderComposer({
      onLoadSkills: vi.fn(async () => undefined),
      skills: [{
        description: "部署",
        enabled: true,
        name: "deploy",
        path: "/skills/deploy",
        scope: "repo",
      }],
    });
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "任务输入" });
    const image = imageFile("history.png");

    await user.type(editor, "$dep");
    await user.click(screen.getByRole("option", { name: /\$deploy/u }));
    fireEvent.change(screen.getByLabelText("选择图片附件"), {
      target: { files: [image] },
    });
    await waitFor(() => expect(screen.getByLabelText("附件")).toHaveTextContent("history.png"));

    editor.focus();
    fireEvent.keyDown(editor, { ctrlKey: true, key: "z" });
    expect(screen.getByLabelText("附件")).toHaveTextContent("history.png");
    expect(screen.queryByLabelText("结构化输入")).not.toBeInTheDocument();

    fireEvent.keyDown(editor, { ctrlKey: true, key: "y" });
    expect(screen.getByLabelText("附件")).toHaveTextContent("history.png");
    expect(screen.getByLabelText("结构化输入")).toHaveTextContent("$deploy");

    await user.click(screen.getByRole("button", { name: "移除 history.png" }));
    editor.focus();
    fireEvent.keyDown(editor, { ctrlKey: true, key: "z" });
    expect(screen.queryByLabelText("附件")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("结构化输入")).not.toBeInTheDocument();

    fireEvent.keyDown(editor, { ctrlKey: true, key: "y" });
    await user.click(screen.getByRole("button", { name: "移除 deploy" }));
    editor.focus();
    fireEvent.keyDown(editor, { ctrlKey: true, key: "z" });
    expect(screen.getByLabelText("结构化输入")).toHaveTextContent("$deploy");
  });

  it("新会话创建后发送失败时将草稿迁移到服务端会话", async () => {
    const draftStore = {
      listKeys: vi.fn(async () => []),
      load: vi.fn(async (key: string) => key === "window:server:draft"
        ? { text: "需要保留", tokens: [] }
        : null),
      save: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      transition: vi.fn(async () => undefined),
    };

    function Harness() {
      const [draftKey, setDraftKey] = useState("window:server:draft");
      return (
        <Composer
          activeTurn={false}
          cwd="/workspace/project"
          draftKey={draftKey}
          draftStore={draftStore}
          error={null}
          onRunShellCommand={async () => true}
          onSend={async () => {
            setDraftKey("window:server:thread");
            return false;
          }}
          onStop={async () => true}
          showProjectPicker
          stopping={false}
          submitting={false}
        />
      );
    }

    render(<Harness />);
    const editor = await screen.findByRole("textbox", { name: "任务输入" });
    await waitFor(() => expect(editor).toHaveValue("需要保留"));
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(editor).toHaveValue("需要保留"));
    await waitFor(() => expect(draftStore.transition).toHaveBeenCalledWith(
      "window:server:draft",
      "window:server:thread",
      { text: "需要保留", tokens: [] },
    ));
  });

  it("草稿迁移期间再次新建时等待发送清理完成", async () => {
    const migrationStarted = deferred();
    const releaseMigration = deferred();
    const releaseTurn = deferred();
    const clearQueued = deferred();
    const drafts = new Map<string, StoredDraft>([
      ["window:server:new", { text: "已经发送的问题", tokens: [] }],
    ]);
    let transitionCount = 0;
    const invoke = vi.fn(async (command: string, payload?: unknown) => {
      const request = (payload as {
        readonly request: {
          readonly draftKey?: string;
          readonly sourceDraftKey?: string;
          readonly targetDraftKey?: string;
          readonly draft?: StoredDraft | null;
        };
      }).request;
      if (command === "load_draft") {
        return drafts.get(request.draftKey!) ?? null;
      }
      if (command === "save_draft") {
        drafts.set(request.draftKey!, request.draft!);
        return null;
      }
      if (command === "delete_draft") {
        drafts.delete(request.draftKey!);
        return null;
      }
      if (command === "transition_draft") {
        transitionCount += 1;
        if (transitionCount === 1) {
          migrationStarted.resolve();
          await releaseMigration.promise;
        }
        drafts.delete(request.sourceDraftKey!);
        if (request.draft === null) {
          drafts.delete(request.targetDraftKey!);
        } else {
          drafts.set(request.targetDraftKey!, request.draft!);
        }
        return null;
      }
      if (command === "list_draft_keys") {
        return [];
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const queuedStore = createDraftStore({ invoke } as Pick<TauriIpc, "invoke">);
    const draftStore: DraftStore = {
      ...queuedStore,
      transition(sourceDraftKey, targetDraftKey, draft) {
        if (draft === null) {
          clearQueued.resolve();
        }
        return queuedStore.transition(sourceDraftKey, targetDraftKey, draft);
      },
    };

    function Harness() {
      const [draftKey, setDraftKey] = useState("window:server:new");
      return (
        <>
          <button onClick={() => setDraftKey("window:server:new")} type="button">
            新建
          </button>
          <Composer
            activeTurn={false}
            cwd="/workspace/project"
            draftKey={draftKey}
            draftStore={draftStore}
            error={null}
            onRunShellCommand={async () => true}
            onSend={async () => {
              setDraftKey("window:server:thread");
              await releaseTurn.promise;
              return true;
            }}
            onStop={async () => true}
            showProjectPicker={draftKey.endsWith(":new")}
            stopping={false}
            submitting={false}
          />
        </>
      );
    }

    render(<Harness />);
    const editor = await screen.findByRole("textbox", { name: "任务输入" });
    await waitFor(() => expect(editor).toHaveValue("已经发送的问题"));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await migrationStarted.promise;

    releaseTurn.resolve();
    await clearQueued.promise;
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    releaseMigration.resolve();

    await waitFor(() => expect(editor).toHaveValue(""));
    expect(drafts.has("window:server:new")).toBe(false);
    expect(transitionCount).toBe(2);
  });

  it("从底栏添加入口打开图片选择器", async () => {
    const user = userEvent.setup();
    renderComposer();
    const picker = screen.getByLabelText("选择图片附件");
    const openPicker = vi.spyOn(picker, "click");

    await user.click(screen.getByRole("button", { name: "添加内容" }));
    await user.click(screen.getByRole("menuitem", { name: /添加图片/ }));

    expect(openPicker).toHaveBeenCalledTimes(1);
  });

  it("从添加菜单进入 Shell 模式并直接执行命令", async () => {
    const user = userEvent.setup();
    const { onRunShellCommand, onSend } = renderComposer();
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "任务输入" });

    await user.click(screen.getByRole("button", { name: "添加内容" }));
    await user.click(screen.getByRole("menuitem", { name: /执行 Shell 命令/u }));

    expect(editor).toHaveValue("!");
    await waitFor(() => expect(editor).toHaveFocus());
    expect(screen.getByText("将在当前服务器直接执行，不受会话权限限制")).toBeVisible();
    expect(screen.getByRole("button", { name: "执行 Shell 命令" })).toBeDisabled();

    await user.type(editor, "git status --short");
    await user.click(screen.getByRole("button", { name: "执行 Shell 命令" }));

    await waitFor(() => expect(onRunShellCommand).toHaveBeenCalledWith(
      "git status --short",
      { cwd: "/workspace/project" },
    ));
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(editor).toHaveValue(""));
  });

  it("已有草稿时不允许菜单将普通输入转换为 Shell 命令", async () => {
    const user = userEvent.setup();
    renderComposer();
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "任务输入" });
    await user.type(editor, "解释当前修改");
    await user.click(screen.getByRole("button", { name: "添加内容" }));

    const shellMenuItem = screen.getByRole("menuitem", { name: /执行 Shell 命令/u });
    expect(shellMenuItem).toBeDisabled();
    expect(shellMenuItem).toHaveTextContent("请先清空当前输入");
    await user.click(shellMenuItem);
    expect(editor).toHaveValue("解释当前修改");
  });

  it("只有原始文本首字符为感叹号时才执行 Shell 命令", async () => {
    const user = userEvent.setup();
    const { onRunShellCommand, onSend } = renderComposer();
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "任务输入" });

    fireEvent.change(editor, { target: { value: " !这是一条普通消息" } });
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "text", text: "!这是一条普通消息" }],
      { cwd: "/workspace/project" },
    ));
    expect(onRunShellCommand).not.toHaveBeenCalled();
  });

  it("Shell 模式拒绝携带附件直到用户移除", async () => {
    const user = userEvent.setup();
    renderComposer();
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "任务输入" });
    await user.type(editor, "!pwd");
    const image = imageFile("shell.png");
    fireEvent.change(screen.getByLabelText("选择图片附件"), {
      target: { files: [image] },
    });

    await waitFor(() => expect(screen.getByLabelText("附件")).toHaveTextContent("shell.png"));
    expect(
      screen.getByText("Shell 命令不能包含附件或结构化引用，请先移除"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "执行 Shell 命令" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "移除 shell.png" }));
    expect(screen.getByRole("button", { name: "执行 Shell 命令" })).toBeEnabled();
  });

  it("Shell 命令提交失败时保留完整草稿", async () => {
    const user = userEvent.setup();
    const onRunShellCommand = vi.fn(async () => false);
    renderComposer({ onRunShellCommand });
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "任务输入" });
    await user.type(editor, "!printf 'hello world'");

    await user.click(screen.getByRole("button", { name: "执行 Shell 命令" }));

    await waitFor(() => expect(onRunShellCommand).toHaveBeenCalledWith(
      "printf 'hello world'",
      { cwd: "/workspace/project" },
    ));
    expect(editor).toHaveValue("!printf 'hello world'");
  });

  it("独立 Shell 回合保留普通草稿但只允许继续执行 Shell 命令", async () => {
    const user = userEvent.setup();
    const { onRunShellCommand, onSend } = renderComposer({
      activeTurn: true,
      shellCommandActive: true,
      showProjectPicker: false,
    });
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "任务输入" });
    await user.type(editor, "稍后发送的普通消息");

    expect(editor).toHaveValue("稍后发送的普通消息");
    expect(screen.getByText("Shell 命令执行完成后可发送普通消息")).toBeVisible();
    expect(screen.queryByRole("button", { name: "追加" })).not.toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: "!pwd" } });
    await user.click(screen.getByRole("button", { name: "执行 Shell 命令" }));
    await waitFor(() => expect(onRunShellCommand).toHaveBeenCalledWith(
      "pwd",
      { cwd: "/workspace/project" },
    ));
  });

  it("常用提示词独立发送并完整保留输入框草稿", async () => {
    const user = userEvent.setup();
    const store = savedPromptStore();
    const { onSend } = renderComposer({ savedPromptStore: store });
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "任务输入" });
    await user.type(editor, "尚未发送的草稿");
    const image = imageFile("draft.png");
    fireEvent.change(screen.getByLabelText("选择图片附件"), { target: { files: [image] } });
    await waitFor(() => expect(screen.getByLabelText("附件")).toHaveTextContent("draft.png"));
    editor.setSelectionRange(2, 6, "forward");
    fireEvent.select(editor);

    await user.click(screen.getByRole("button", { name: "添加内容" }));
    await user.click(screen.getByRole("menuitem", { name: /常用提示词/u }));
    await user.click(await screen.findByRole("button", { name: "发送 代码审查" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "text", text: "  审查当前修改  " }],
      { cwd: "/workspace/project" },
    ));
    expect(editor).toHaveValue("尚未发送的草稿");
    expect(screen.getByLabelText("附件")).toHaveTextContent("draft.png");
    await waitFor(() => expect(editor).toHaveFocus());
    expect(editor.selectionStart).toBe(2);
    expect(editor.selectionEnd).toBe(6);
  });

  it("复制常用提示词且不发送或关闭浮层", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ savedPromptStore: savedPromptStore() });
    const writeText = vi.spyOn(navigator.clipboard, "writeText");

    await user.click(screen.getByRole("button", { name: "添加内容" }));
    await user.click(screen.getByRole("menuitem", { name: /常用提示词/u }));
    const copy = await screen.findByRole("button", { name: "复制 代码审查" });
    const send = screen.getByRole("button", { name: "发送 代码审查" });

    expect(within(copy).getByText("复制")).not.toBeVisible();
    expect(within(send).getByText("发送")).not.toBeVisible();
    await user.click(copy);

    expect(writeText).toHaveBeenCalledWith("  审查当前修改  ");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "选择常用提示词" })).toBeVisible();
    expect(within(copy).getByText("已复制")).toBeInTheDocument();
  });

  it("在新会话首次发送常用提示词时迁移并保留原草稿", async () => {
    const user = userEvent.setup();
    const promptStore = savedPromptStore();
    const draftStore = {
      listKeys: vi.fn(async () => []),
      load: vi.fn(async (key: string) => key === "window:server:draft"
        ? { text: "需要稍后发送", tokens: [] }
        : null),
      save: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      transition: vi.fn(async () => undefined),
    };
    const onSend = vi.fn<ComponentProps<typeof Composer>["onSend"]>(async () => true);

    function Harness() {
      const [draftKey, setDraftKey] = useState("window:server:draft");
      return (
        <Composer
          activeTurn={false}
          cwd="/workspace/project"
          draftKey={draftKey}
          draftStore={draftStore}
          error={null}
          onRunShellCommand={async () => true}
          onSend={async (...arguments_) => {
            setDraftKey("window:server:thread");
            return onSend(...arguments_);
          }}
          onStop={async () => true}
          savedPromptStore={promptStore}
          showProjectPicker
          stopping={false}
          submitting={false}
        />
      );
    }

    render(<Harness />);
    const editor = await screen.findByRole("textbox", { name: "任务输入" });
    await waitFor(() => expect(editor).toHaveValue("需要稍后发送"));
    await user.click(screen.getByRole("button", { name: "添加内容" }));
    await user.click(screen.getByRole("menuitem", { name: /常用提示词/u }));
    await user.click(await screen.findByRole("button", { name: "发送 代码审查" }));

    await waitFor(() => expect(editor).toHaveValue("需要稍后发送"));
    await waitFor(() => expect(draftStore.transition).toHaveBeenCalledWith(
      "window:server:draft",
      "window:server:thread",
      { text: "需要稍后发送", tokens: [] },
    ));
  });

  it("管理常用提示词支持增删改查和手动排序", async () => {
    const user = userEvent.setup();
    const store = savedPromptStore([]);
    renderComposer({ savedPromptStore: store });

    await user.click(screen.getByRole("button", { name: "添加内容" }));
    await user.click(screen.getByRole("menuitem", { name: /常用提示词/u }));
    await user.click(await screen.findByRole("button", { name: "新建提示词" }));
    expect(screen.getByRole("dialog", { name: "新建常用提示词" })).toBeVisible();
    await user.type(screen.getByLabelText("名称"), "代码审查");
    await user.type(screen.getByLabelText("提示词内容"), "审查当前修改");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("dialog", { name: "管理常用提示词" })).toBeVisible();

    const firstRow = screen.getByText("代码审查").closest("article")!;
    await user.click(within(firstRow).getByRole("button", { name: "编辑" }));
    await user.clear(screen.getByLabelText("名称"));
    await user.type(screen.getByLabelText("名称"), "严格审查");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("严格审查")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "新建提示词" }));
    await user.type(screen.getByLabelText("名称"), "补充测试");
    await user.type(screen.getByLabelText("提示词内容"), "补充关键路径测试");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(await screen.findByRole("button", { name: "上移 补充测试" }));
    expect(store.reorder).toHaveBeenCalledWith([
      "11111111-1111-4111-8111-000000000003",
      "11111111-1111-4111-8111-000000000002",
    ]);

    const search = screen.getByRole("searchbox", { name: "搜索常用提示词" });
    await user.type(search, "严格");
    expect(screen.getByText("严格审查")).toBeVisible();
    expect(screen.queryByText("补充测试")).not.toBeInTheDocument();
    await user.clear(search);

    const deleteRow = screen.getByText("严格审查").closest("article")!;
    await user.click(within(deleteRow).getByRole("button", { name: "删除" }));
    await user.click(within(deleteRow).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.queryByText("严格审查")).not.toBeInTheDocument());
    expect(store.delete).toHaveBeenCalledTimes(1);
  });

  it("只在新建会话的输入框上方显示项目选择器", () => {
    const view = renderComposer();
    const projectPicker = screen.getByRole("button", { name: "项目" });
    const editor = screen.getByRole("textbox", { name: "任务输入" });

    expect(projectPicker.closest("footer")).toBeNull();
    expect(
      projectPicker.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    view.unmount();
    renderComposer({ showProjectPicker: false });
    expect(screen.queryByRole("button", { name: "项目" })).not.toBeInTheDocument();
  });

  it("仅在新建会话页通过 Ctrl+O 打开项目选择器", () => {
    const view = renderComposer({
      onCwdChange: vi.fn(),
      projectCwds: ["/workspace/project", "/workspace/other"],
    });

    fireEvent.keyDown(window, { ctrlKey: true, key: "o" });
    expect(screen.getByRole("dialog", { name: "项目设置" })).toBeVisible();
    expect(screen.getByRole("button", { name: "项目" })).toHaveFocus();

    view.unmount();
    renderComposer({ showProjectPicker: false });
    fireEvent.keyDown(window, { ctrlKey: true, key: "o" });
    expect(screen.queryByRole("dialog", { name: "项目设置" })).not.toBeInTheDocument();
  });

  it("在项目选择器右侧删除当前受信任项目", async () => {
    const user = userEvent.setup();
    const onDeleteProject = vi.fn(async () => undefined);
    renderComposer({
      cwd: "/workspace/project",
      onCwdChange: vi.fn(),
      onDeleteProject,
      projectCwds: ["/workspace/project", "/workspace/other"],
    });

    const projectPicker = screen.getByRole("button", { name: "项目" });
    const deleteButton = screen.getByRole("button", {
      name: "删除项目 project",
    });
    expect(
      projectPicker.compareDocumentPosition(deleteButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    await user.click(deleteButton);
    const dialog = screen.getByRole("dialog", { name: "删除受信任项目？" });
    expect(dialog).toHaveTextContent("/workspace/project");
    expect(dialog).toHaveTextContent("不会删除项目文件");
    await user.click(within(dialog).getByRole("button", { name: "删除项目" }));

    expect(onDeleteProject).toHaveBeenCalledWith("/workspace/project");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "删除受信任项目？" }),
      ).not.toBeInTheDocument()
    );
  });

  it("删除受信任项目失败时保留确认框并展示错误", async () => {
    const user = userEvent.setup();
    renderComposer({
      cwd: "/workspace/project",
      onCwdChange: vi.fn(),
      onDeleteProject: vi.fn(async () => {
        throw new Error("write failed");
      }),
      projectCwds: ["/workspace/project"],
    });

    await user.click(screen.getByRole("button", {
      name: "删除项目 project",
    }));
    await user.click(screen.getByRole("button", { name: "删除项目" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法删除受信任项目，请重试",
    );
    expect(
      screen.getByRole("dialog", { name: "删除受信任项目？" }),
    ).toBeVisible();
  });

  it("设置命令直接打开客户端设置", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    renderComposer({ onOpenSettings });

    await user.type(screen.getByRole("textbox", { name: "任务输入" }), "/sett");
    await user.click(screen.getByRole("option", { name: /\/settings/u }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "任务输入" })).toHaveValue("");
  });

  it("模型菜单展示说明并支持键盘选择", async () => {
    const models: NonNullable<ComponentProps<typeof Composer>["models"]> = [
      {
        defaultReasoningEffort: "medium",
        description: "适合日常编码任务",
        displayName: "GPT-5",
        hidden: false,
        id: "gpt-5",
        isDefault: true,
        model: "gpt-5",
        supportedReasoningEfforts: [
          { description: "平衡速度与质量", reasoningEffort: "medium" },
        ],
      },
      {
        defaultReasoningEffort: "high",
        description: "适合复杂工程任务",
        displayName: "GPT-5 Pro",
        hidden: false,
        id: "gpt-5-pro",
        inputModalities: ["text", "image"],
        isDefault: false,
        model: "gpt-5-pro",
        supportsPersonality: true,
        supportedReasoningEfforts: [
          { description: "更深入推理", reasoningEffort: "high" },
        ],
      },
    ];
    const user = userEvent.setup();
    const { onSend } = renderComposer({ models });
    const trigger = await screen.findByRole("button", { name: "模型" });
    expect(trigger).toHaveTextContent("默认 · GPT-5 · medium");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("dialog", { name: "模型设置" })).toBeVisible();
    expect(screen.getByRole("listbox", { name: "选择模型" })).toBeVisible();
    expect(screen.getByText("适合复杂工程任务")).toBeVisible();
    expect(screen.getByText("文本输入 · 图片输入 · 可调推理强度 · 个性化")).toBeVisible();
    expect(screen.getByRole("option", { name: /✓ 服务器默认 · GPT-5/u })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger).toHaveTextContent("GPT-5 Pro · 默认 high");
    fireEvent.click(trigger);
    expect(screen.getByRole("combobox", { name: "思考程度" })).toHaveDisplayValue(
      "服务器默认 · high",
    );
    fireEvent.change(screen.getByRole("combobox", { name: "思考程度" }), {
      target: { value: "high" },
    });
    expect(trigger).toHaveTextContent("GPT-5 Pro · high");
    expect(screen.queryByRole("combobox", { name: "推理强度" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "任务输入" }), "分析问题");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "text", text: "分析问题" }],
      { cwd: "/workspace/project", effort: "high", model: "gpt-5-pro" },
    ));
  });

  it("展示目录配置中的默认模型和思考程度但不作为请求覆盖发送", async () => {
    const models: NonNullable<ComponentProps<typeof Composer>["models"]> = [
      {
        defaultReasoningEffort: "medium",
        description: "目录推荐模型",
        displayName: "GPT-5",
        hidden: false,
        id: "gpt-5",
        isDefault: true,
        model: "gpt-5",
        supportedReasoningEfforts: [
          { description: "平衡速度与质量", reasoningEffort: "medium" },
        ],
      },
      {
        defaultReasoningEffort: "medium",
        description: "当前项目配置模型",
        displayName: "GPT-5 Pro",
        hidden: false,
        id: "gpt-5-pro",
        isDefault: false,
        model: "gpt-5-pro",
        supportedReasoningEfforts: [
          { description: "平衡速度与质量", reasoningEffort: "medium" },
          { description: "更深入推理", reasoningEffort: "high" },
        ],
      },
    ];
    const user = userEvent.setup();
    const { onSend } = renderComposer({
      defaultEffort: "high",
      defaultModel: "gpt-5-pro",
      defaultModelSource: "config",
      models,
    });

    const trigger = screen.getByRole("button", { name: "模型" });
    expect(trigger).toHaveTextContent("配置 · GPT-5 Pro · high");
    await user.click(trigger);
    expect(screen.getByRole("option", { name: /✓ 目录配置 · GPT-5 Pro/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "思考程度" })).toHaveDisplayValue(
      "目录配置 · high",
    );

    await user.type(screen.getByRole("textbox", { name: "任务输入" }), "沿用目录配置");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "text", text: "沿用目录配置" }],
      { cwd: "/workspace/project" },
    ));
  });

  it("未选择会话参数时完全沿用服务器默认值", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ cwd: null });

    await user.type(screen.getByRole("textbox", { name: "任务输入" }), "使用默认配置");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "text", text: "使用默认配置" }],
      {},
    ));
  });

  it("只为当前会话切换 Fast 并将目录返回的 tier id 传给服务端", async () => {
    const onServiceTierChange = vi.fn(async () => true);
    const user = userEvent.setup();
    const { onSend } = renderComposer({
      models: [{
        defaultReasoningEffort: "medium",
        defaultServiceTier: null,
        description: "通用模型",
        displayName: "GPT-5",
        hidden: false,
        id: "gpt-5",
        isDefault: true,
        model: "gpt-5",
        serviceTiers: [{
          description: "响应更快，使用量消耗更高",
          id: "priority",
          name: "Fast",
        }],
        supportedReasoningEfforts: [
          { description: "平衡速度与质量", reasoningEffort: "medium" },
        ],
      }],
      onServiceTierChange,
      showProjectPicker: false,
    });

    const fastSwitch = screen.getByRole("switch", { name: "当前会话 Fast 模式" });
    expect(fastSwitch).toHaveAttribute("aria-checked", "false");
    expect(fastSwitch).toHaveAttribute("title", expect.stringContaining("仅影响当前会话"));
    await user.click(fastSwitch);
    await waitFor(() => expect(onServiceTierChange).toHaveBeenCalledWith("priority"));
    expect(fastSwitch).toHaveAttribute("aria-checked", "true");

    await user.type(screen.getByRole("textbox", { name: "任务输入" }), "快速处理");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "text", text: "快速处理" }],
      { cwd: "/workspace/project", serviceTier: "priority" },
    ));
  });

  it("权限菜单解释策略并明确警告高风险配置", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({
      permissions: [
        { allowed: true, id: ":read-only" },
        { allowed: true, id: ":workspace" },
        { allowed: true, id: ":danger-full-access" },
        { allowed: false, description: "组织托管配置", id: "managed" },
      ],
    });

    await user.click(screen.getByRole("button", { name: "权限" }));
    expect(screen.getByText(/文件系统只读，网络受限/u)).toBeVisible();
    expect(screen.getByText(/允许写入当前工作区/u)).toBeVisible();
    const fullAccess = screen.getByRole("option", { name: /完全访问高风险/u });
    expect(fullAccess).toHaveAttribute("data-risk", "high");
    expect(screen.getByRole("option", { name: /服务器当前不允许/u })).toHaveAttribute("aria-disabled", "true");

    await user.click(fullAccess);
    await user.type(screen.getByRole("textbox", { name: "任务输入" }), "检查项目");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "text", text: "检查项目" }],
      { cwd: "/workspace/project", permissions: ":danger-full-access" },
    ));
  });

  it("展示明确的默认权限但发送时保持字段省略", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({
      defaultPermission: ":workspace",
      permissions: [{ allowed: true, id: ":workspace" }],
    });

    const permissionTrigger = screen.getByRole("button", { name: "权限" });
    expect(permissionTrigger).toHaveTextContent("默认 · 工作区写入");
    await user.click(permissionTrigger);
    expect(screen.getByRole("option", { name: /✓ 默认 · 工作区写入/u })).toBeVisible();

    await user.type(screen.getByRole("textbox", { name: "任务输入" }), "使用默认权限");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "text", text: "使用默认权限" }],
      { cwd: "/workspace/project" },
    ));
  });

  it("运行中根据输入区分停止和追加", async () => {
    const user = userEvent.setup();
    const { onSend, onStop } = renderComposer({ activeTurn: true, showProjectPicker: false });
    expect(screen.queryByText("Codex 正在处理当前回合")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalledTimes(1);

    await user.type(screen.getByRole("textbox"), "补充条件");
    expect(screen.getByRole("button", { name: "追加" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "停止当前回合" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "text", text: "补充条件" }],
      { cwd: "/workspace/project" },
    ));
  });

  it("从服务端技能菜单插入结构化令牌", async () => {
    const user = userEvent.setup();
    const onLoadSkills = vi.fn(async () => undefined);
    const { onSend } = renderComposer({
      onLoadSkills,
      skills: [{
        description: "部署当前项目",
        enabled: true,
        name: "deploy",
        path: "/skills/deploy/SKILL.md",
        scope: "repo",
      }],
    });

    await user.type(screen.getByRole("textbox", { name: "任务输入" }), "$dep");
    await waitFor(() => expect(onLoadSkills).toHaveBeenCalledWith(false));
    await user.click(screen.getByRole("option", { name: /\$deploy/u }));
    expect(screen.getByLabelText("结构化输入")).toHaveTextContent("$deploy");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "skill", name: "deploy", path: "/skills/deploy/SKILL.md" }],
      { cwd: "/workspace/project" },
    ));
  });

  it("使用服务端文件搜索插入 mention 并支持键盘选择", async () => {
    const user = userEvent.setup();
    const onSearchFiles = vi.fn(async () => [{
      file_name: "README.md",
      match_type: "file" as const,
      path: "docs/README.md",
      root: "/workspace/project",
      score: 10,
    }]);
    renderComposer({ onSearchFiles });
    const editor = screen.getByRole("textbox", { name: "任务输入" });

    await user.type(editor, "@read");
    await waitFor(() => expect(screen.getByRole("option", { name: /@README\.md/u })).toBeVisible());
    expect(screen.getByText("文件与任务")).toBeVisible();
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(screen.getByLabelText("结构化输入")).toHaveTextContent("@README.md");
    expect(onSearchFiles).toHaveBeenCalledWith("read");
  });

  it.each([
    ["应用", "Calendar", "app://calendar"],
    ["插件", "Design Tools", "plugin://design@official"],
  ] as const)("@ 菜单插入%s结构化引用", async (_kind, name, path) => {
    const user = userEvent.setup();
    const onLoadMentions = vi.fn(async () => undefined);
    const { onSend } = renderComposer({
      mentionReferences: [{
        kind: path.startsWith("app://") ? "app" : "plugin",
        name,
        description: `${name} 能力`,
        source: "官方目录",
        path,
        searchTerms: [name, path],
      }],
      onLoadMentions,
    });

    await user.type(screen.getByRole("textbox", { name: "任务输入" }), `@${name.slice(0, 3)}`);
    await waitFor(() => expect(onLoadMentions).toHaveBeenCalledWith(false));
    expect(screen.getByText(_kind)).toBeVisible();
    await user.click(screen.getByRole("option", { name: new RegExp(`@${name}`, "u") }));
    expect(screen.getByLabelText("结构化输入")).toHaveTextContent(`@${name}`);
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "mention", name, path }],
      { cwd: "/workspace/project" },
    ));
  });

  it("立即命令调用协议动作且输入法合成期间不打开菜单", async () => {
    const user = userEvent.setup();
    const onRunImmediateCommand = vi.fn(async () => true);
    renderComposer({ canRunImmediateCommands: true, onRunImmediateCommand });
    const editor = screen.getByRole("textbox", { name: "任务输入" });

    fireEvent.compositionStart(editor);
    fireEvent.change(editor, { target: { value: "/" } });
    expect(screen.queryByRole("listbox", { name: "输入建议" })).not.toBeInTheDocument();
    fireEvent.compositionEnd(editor);
    await user.type(editor, "comp");
    await user.click(screen.getByRole("option", { name: /\/compact/u }));

    expect(onRunImmediateCommand).toHaveBeenCalledWith("compact");
  });

  it("通过文件选择和剪贴板项目添加图片附件并结构化发送", async () => {
    const user = userEvent.setup();
    const { blobUrlFactory, onSend } = renderComposer();
    const picker = screen.getByLabelText("选择图片附件");
    const image = imageFile("screen.png");

    fireEvent.change(picker, { target: { files: [image] } });
    await waitFor(() => expect(screen.getByLabelText("附件")).toHaveTextContent("screen.png"));
    await waitFor(() => expect(blobUrlFactory.create).toHaveBeenCalledWith(image));
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "image", url: expect.stringMatching(/^data:image\/png;base64,/u) }],
      { cwd: "/workspace/project" },
    ));

    const clipboardImage = imageFile("paste.webp", "image/webp");
    const getAsFile = vi.fn(() => clipboardImage);
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: {
        items: [{ getAsFile, kind: "file", type: "image/webp" }],
      },
    });
    await waitFor(() => expect(screen.getByLabelText("附件")).toHaveTextContent("paste.webp"));
    expect(getAsFile).toHaveBeenCalledTimes(1);
  });

  it("普通文本粘贴不阻止浏览器默认行为", () => {
    const clipboardFilesReader = vi.fn(async () => []);
    renderComposer({ clipboardFilesReader });
    const editor = screen.getByRole("textbox", { name: "任务输入" });
    const event = createEvent.paste(editor, {
      clipboardData: {
        getData: () => "普通文本",
        items: [{ getAsFile: () => null, kind: "string", type: "text/plain" }],
        types: ["text/plain", "image/png"],
      },
    });

    fireEvent(editor, event);

    expect(event.defaultPrevented).toBe(false);
    expect(clipboardFilesReader).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("附件")).not.toBeInTheDocument();
  });

  it("本地路径文字不读取原生剪贴板", () => {
    const clipboardFilesReader = vi.fn(async () => []);
    renderComposer({ clipboardFilesReader, initialText: "查看 " });
    const editor = screen.getByRole("textbox", { name: "任务输入" }) as HTMLTextAreaElement;
    editor.setSelectionRange(3, 3);
    const event = createEvent.paste(editor, {
      clipboardData: {
        getData: () => "/tmp/screen.png",
        items: [{ getAsFile: () => null, kind: "string", type: "text/plain" }],
        types: ["text/plain"],
      },
    });

    fireEvent(editor, event);

    expect(event.defaultPrevented).toBe(false);
    expect(clipboardFilesReader).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("附件")).not.toBeInTheDocument();
  });

  it("将 Linux 文件 URI 剪贴板读取为图片而不是粘贴路径", async () => {
    const clipboardImage = imageFile("linux-paste.png");
    const clipboardFilesReader = vi.fn(async () => [{
      name: clipboardImage.name,
      size: clipboardImage.size,
      file: clipboardImage,
      error: null,
    }]);
    renderComposer({ clipboardFilesReader });
    const editor = screen.getByRole("textbox", { name: "任务输入" });
    const event = createEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => type === "text/uri-list"
          ? "file:///tmp/linux-paste.png\r\n"
          : "/tmp/linux-paste.png",
        items: [{ getAsFile: () => null, kind: "string", type: "text/plain" }],
        types: ["text/plain", "text/uri-list"],
      },
    });

    fireEvent(editor, event);

    expect(event.defaultPrevented).toBe(true);
    expect(clipboardFilesReader).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByLabelText("附件")).toHaveTextContent("linux-paste.png"),
    );
    expect(editor).toHaveValue("");
  });

  it("WebKit 未暴露文件项目时从原生剪贴板读取截图", async () => {
    const screenshot = imageFile("粘贴图片.png");
    const clipboardRead = deferred<readonly [{
      readonly name: string;
      readonly size: number;
      readonly file: File;
      readonly error: null;
    }]>();
    const clipboardFilesReader = vi.fn(() => clipboardRead.promise);
    const result = [{
      name: screenshot.name,
      size: screenshot.size,
      file: screenshot,
      error: null,
    }] as const;
    renderComposer({ clipboardFilesReader });
    const editor = screen.getByRole("textbox", { name: "任务输入" });
    const event = createEvent.paste(editor, {
      clipboardData: {
        getData: () => "",
        items: [],
        types: [],
      },
    });

    fireEvent(editor, event);

    expect(event.defaultPrevented).toBe(false);
    expect(clipboardFilesReader).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取剪贴板图片");
    clipboardRead.resolve(result);
    await waitFor(() =>
      expect(screen.getByLabelText("附件")).toHaveTextContent("粘贴图片.png"),
    );
  });

  it("URI 剪贴板中的网页链接不读取原生剪贴板", () => {
    const clipboardFilesReader = vi.fn(async () => []);
    renderComposer({ clipboardFilesReader });
    const editor = screen.getByRole("textbox", { name: "任务输入" });
    const event = createEvent.paste(editor, {
      clipboardData: {
        getData: () => "https://example.com/image.png",
        items: [{ getAsFile: () => null, kind: "string", type: "text/uri-list" }],
        types: ["text/plain", "text/uri-list"],
      },
    });

    fireEvent(editor, event);

    expect(event.defaultPrevented).toBe(false);
    expect(clipboardFilesReader).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("附件")).not.toBeInTheDocument();
  });

  it("图片读取期间立即保留顺序并阻止发送", async () => {
    const firstReady = deferred();
    const imageValidator = vi.fn((blob: Blob) =>
      blob.type === "image/png" ? firstReady.promise : Promise.resolve(),
    );
    renderComposer({ imageValidator });
    const editor = screen.getByRole("textbox", { name: "任务输入" });

    fireEvent.paste(editor, {
      clipboardData: {
        items: [{
          getAsFile: () => imageFile("first.png"),
          kind: "file",
          type: "image/png",
        }],
      },
    });
    fireEvent.paste(editor, {
      clipboardData: {
        items: [{
          getAsFile: () => imageFile("second.webp", "image/webp"),
          kind: "file",
          type: "image/webp",
        }],
      },
    });

    const attachmentArea = screen.getByLabelText("附件");
    expect([...attachmentArea.querySelectorAll("article")].map((item) => item.textContent))
      .toEqual([
        expect.stringContaining("first.png"),
        expect.stringContaining("second.webp"),
      ]);
    expect(attachmentArea).toHaveTextContent("正在读取图片");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await waitFor(() => expect(attachmentArea).toHaveTextContent("second.webp"));

    firstReady.resolve();
    await waitFor(() => expect(attachmentArea).not.toHaveTextContent("正在读取图片"));
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("按图片内容识别格式并拒绝 SVG 和无法解码的图片", async () => {
    const pngBytes = imageFile("source.png").slice();
    const mislabeled = new File([pngBytes], "mislabeled.svg", { type: "image/svg+xml" });
    const invalid = imageFile("invalid.png");
    const imageValidator = vi.fn(async (blob: Blob) => {
      if (blob === invalid) throw new TypeError("decode failed");
    });
    renderComposer({ imageValidator });
    const picker = screen.getByLabelText("选择图片附件");

    fireEvent.change(picker, { target: { files: [mislabeled] } });
    await waitFor(() =>
      expect(screen.getByLabelText("附件")).toHaveTextContent("mislabeled.svg"),
    );
    expect(imageValidator).toHaveBeenCalledWith(expect.objectContaining({ type: "image/png" }));
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();

    const svg = new File(
      ['<svg xmlns="http://www.w3.org/2000/svg"/>'],
      "vector.svg",
      { type: "image/svg+xml" },
    );
    fireEvent.change(picker, { target: { files: [svg] } });
    await waitFor(() =>
      expect(screen.getByText("不支持或无法识别此图片格式")).toBeVisible(),
    );
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();

    fireEvent.change(picker, { target: { files: [invalid] } });
    await waitFor(() =>
      expect(screen.getByText("图片内容无效或无法解码")).toBeVisible(),
    );
  });

  it("为没有文件名的剪贴板图片生成稳定名称", async () => {
    renderComposer();
    const unnamed = imageFile("", "image/png");

    fireEvent.paste(screen.getByRole("textbox", { name: "任务输入" }), {
      clipboardData: {
        items: [{ getAsFile: () => unnamed, kind: "file", type: "image/png" }],
      },
    });

    await waitFor(() =>
      expect(screen.getByLabelText("附件")).toHaveTextContent("粘贴图片.png"),
    );
    expect(screen.getByRole("button", { name: "移除 粘贴图片.png" })).toBeVisible();
  });

  it("拖放图片复用附件处理并在移除时释放 Blob URL", async () => {
    const user = userEvent.setup();
    const { blobUrlFactory } = renderComposer();
    const image = imageFile("drop.png");

    fireEvent.drop(screen.getByRole("textbox").closest("div")!, {
      dataTransfer: { files: [image] },
    });

    await waitFor(() => expect(screen.getByLabelText("附件")).toHaveTextContent("drop.png"));
    await waitFor(() => expect(blobUrlFactory.create).toHaveBeenCalledWith(image));
    await user.click(screen.getByRole("button", { name: "移除 drop.png" }));
    expect(blobUrlFactory.revoke).toHaveBeenCalledWith("blob:attachment-0");
  });

  it("所选模型不支持图片时保留附件并阻止发送", async () => {
    const models: NonNullable<ComponentProps<typeof Composer>["models"]> = [{
      defaultReasoningEffort: "medium",
      description: "仅支持文本",
      displayName: "Text Model",
      hidden: false,
      id: "text-model",
      inputModalities: ["text"],
      isDefault: true,
      model: "text-model",
      supportedReasoningEfforts: [],
    }];
    renderComposer({ models });
    const image = imageFile("screen.png");

    fireEvent.change(screen.getByLabelText("选择图片附件"), { target: { files: [image] } });

    await waitFor(() => expect(screen.getByLabelText("附件")).toHaveTextContent("当前模型不支持图片输入"));
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByLabelText("附件")).toHaveTextContent("screen.png");
  });

  it("保留不支持的附件并阻止发送直到用户移除", async () => {
    const user = userEvent.setup();
    renderComposer();
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    fireEvent.drop(screen.getByRole("textbox").closest("div")!, {
      dataTransfer: { files: [file] },
    });

    await waitFor(() => expect(screen.getByText("当前服务器输入仅支持图片附件")).toBeVisible());
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "移除 notes.txt" }));
    expect(screen.queryByLabelText("附件")).not.toBeInTheDocument();
  });

  it("支持切换配置项目和输入绝对路径且结构化令牌需两次退格删除", async () => {
    const user = userEvent.setup();
    const onCwdChange = vi.fn();
    renderComposer({
      cwd: null,
      onCwdChange,
      projectCwds: ["/workspace/recent"],
      onLoadSkills: vi.fn(async () => undefined),
      skills: [{ description: "部署", enabled: true, name: "deploy", path: "/skills/deploy", scope: "repo" }],
    });

    const cwdPicker = screen.getByRole("button", { name: "项目" });
    await user.click(cwdPicker);
    await user.click(screen.getByRole("option", { name: /recent/u }));
    expect(onCwdChange).toHaveBeenCalledWith("/workspace/recent");

    await user.click(cwdPicker);
    await user.click(screen.getByRole("button", { name: "输入自定义目录…" }));
    const cwdInput = screen.getByRole("textbox", { name: "服务器工作目录" });
    await user.type(cwdInput, "relative/path");
    await user.click(screen.getByRole("button", { name: "应用" }));
    expect(screen.getByRole("alert")).toHaveTextContent("绝对路径");
    await user.clear(cwdInput);
    await user.type(cwdInput, "/remote/project");
    await user.click(screen.getByRole("button", { name: "应用" }));
    expect(onCwdChange).toHaveBeenCalledWith("/remote/project");

    await user.click(cwdPicker);
    expect(screen.getByRole("option", { name: /recent/u })).toBeVisible();
    expect(screen.queryByRole("option", { name: /remote\/project/u })).not.toBeInTheDocument();
    await user.click(cwdPicker);

    const editor = screen.getByRole("textbox", { name: "任务输入" });
    await user.type(editor, "$dep");
    await user.click(screen.getByRole("option", { name: /\$deploy/u }));
    fireEvent.keyDown(editor, { key: "Backspace" });
    expect(screen.getByText("$deploy").parentElement).toHaveAttribute("data-selected", "true");
    fireEvent.keyDown(editor, { key: "Backspace" });
    expect(screen.queryByLabelText("结构化输入")).not.toBeInTheDocument();
  });
});
