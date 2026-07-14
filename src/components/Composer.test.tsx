import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer";

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
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
      onSend={onSend}
      onStop={onStop}
      showProjectPicker={true}
      stopping={false}
      submitting={false}
      {...overrides}
    />,
  );
  return { blobUrlFactory, onSend, onStop, unmount: result.unmount };
}

describe("Composer", () => {
  it("从 SQLite 草稿存储恢复并在停止输入后保存", async () => {
    const user = userEvent.setup();
    const draftStore = {
      load: vi.fn(async () => ({
        text: "恢复内容",
        tokens: [{ type: "mention" as const, name: "README", path: "/workspace/README.md" }],
      })),
      save: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
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

  it("Enter 发送成功后清空，Shift+Enter 保留换行", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    const editor = screen.getByRole("textbox", { name: "任务输入" });
    await user.type(editor, "第一行{shift>}{enter}{/shift}第二行");
    expect(editor).toHaveValue("第一行\n第二行");

    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "text", text: "第一行\n第二行" }],
      { cwd: "/workspace/project" },
    ));
    await waitFor(() => expect(editor).toHaveValue(""));
  });

  it("从底栏添加入口打开图片选择器", async () => {
    const user = userEvent.setup();
    renderComposer();
    const picker = screen.getByLabelText("选择图片附件");
    const openPicker = vi.spyOn(picker, "click");

    await user.click(screen.getByRole("button", { name: "添加内容" }));

    expect(openPicker).toHaveBeenCalledTimes(1);
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
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("dialog", { name: "模型设置" })).toBeVisible();
    expect(screen.getByRole("listbox", { name: "选择模型" })).toBeVisible();
    expect(screen.getByText("适合复杂工程任务")).toBeVisible();
    expect(screen.getByText("文本输入 · 图片输入 · 可调推理强度 · 个性化")).toBeVisible();
    expect(screen.getByRole("option", { name: /✓ 服务器默认/u })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger).toHaveTextContent("GPT-5 Pro");
    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole("combobox", { name: "思考程度" }), {
      target: { value: "high" },
    });
    expect(screen.queryByRole("combobox", { name: "推理强度" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "任务输入" }), "分析问题");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "text", text: "分析问题" }],
      { cwd: "/workspace/project", effort: "high", model: "gpt-5-pro" },
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
    const image = new File([new Uint8Array([137, 80, 78, 71])], "screen.png", { type: "image/png" });

    fireEvent.change(picker, { target: { files: [image] } });
    await waitFor(() => expect(screen.getByLabelText("附件")).toHaveTextContent("screen.png"));
    await waitFor(() => expect(blobUrlFactory.create).toHaveBeenCalledWith(image));
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      [{ type: "image", url: expect.stringMatching(/^data:image\/png;base64,/u) }],
      { cwd: "/workspace/project" },
    ));

    const clipboardImage = new File([new Uint8Array([1, 2])], "paste.webp", { type: "image/webp" });
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
    renderComposer();
    const editor = screen.getByRole("textbox", { name: "任务输入" });
    const event = createEvent.paste(editor, {
      clipboardData: {
        items: [{ getAsFile: () => null, kind: "string", type: "text/plain" }],
      },
    });

    fireEvent(editor, event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByLabelText("附件")).not.toBeInTheDocument();
  });

  it("拖放图片复用附件处理并在移除时释放 Blob URL", async () => {
    const user = userEvent.setup();
    const { blobUrlFactory } = renderComposer();
    const image = new File([new Uint8Array([1, 2])], "drop.png", { type: "image/png" });

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
    const image = new File([new Uint8Array([137, 80, 78, 71])], "screen.png", { type: "image/png" });

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

  it("支持切换最近目录和输入绝对路径且结构化令牌需两次退格删除", async () => {
    const user = userEvent.setup();
    const onCwdChange = vi.fn();
    renderComposer({
      cwd: null,
      onCwdChange,
      recentCwds: ["/workspace/recent", "/workspace/recent"],
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

    const editor = screen.getByRole("textbox", { name: "任务输入" });
    await user.type(editor, "$dep");
    await user.click(screen.getByRole("option", { name: /\$deploy/u }));
    fireEvent.keyDown(editor, { key: "Backspace" });
    expect(screen.getByText("$deploy").parentElement).toHaveAttribute("data-selected", "true");
    fireEvent.keyDown(editor, { key: "Backspace" });
    expect(screen.queryByLabelText("结构化输入")).not.toBeInTheDocument();
  });
});
