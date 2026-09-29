import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AsyncQuestionView } from "../app/useAsyncQuestions";
import {
  AsyncQuestionPanel,
  type AsyncQuestionPanelProps,
} from "./AsyncQuestionPanel";
import { ComposerAccessoryPanel } from "./ComposerAccessoryPanel";

const QUESTION: AsyncQuestionView = {
  key: "item-1:0",
  title: "你希望讲解多详细？",
  options: ["简洁", "适中：原理加一个示例", "详细"],
  draft: "",
  customAnswer: false,
  status: "pending",
  answer: null,
  error: null,
};

function props(overrides: Partial<AsyncQuestionPanelProps> = {}) {
  return {
    questions: [QUESTION],
    selectedKey: QUESTION.key,
    expanded: true,
    disabled: false,
    error: null,
    onExpandedChange: vi.fn(),
    onSelect: vi.fn(),
    onDraftChange: vi.fn(),
    onCustomAnswerChange: vi.fn(),
    onAnswer: vi.fn(),
    onIgnore: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  } satisfies AsyncQuestionPanelProps;
}

describe("AsyncQuestionPanel", () => {
  it("问题到达时不抢焦点，键盘点击选项只提交选项原文", async () => {
    const user = userEvent.setup();
    const panelProps = props();
    const { rerender } = render(
      <>
        <textarea aria-label="消息草稿" defaultValue="正在写的草稿" />
        <AsyncQuestionPanel {...panelProps} questions={[]} />
      </>,
    );
    const composer = screen.getByRole("textbox", { name: "消息草稿" });
    composer.focus();

    rerender(
      <>
        <textarea aria-label="消息草稿" defaultValue="正在写的草稿" />
        <AsyncQuestionPanel {...panelProps} />
      </>,
    );

    expect(composer).toHaveFocus();
    screen.getByRole("button", { name: "适中：原理加一个示例" }).focus();
    await user.keyboard("{Enter}");

    expect(panelProps.onAnswer).toHaveBeenCalledExactlyOnceWith(
      QUESTION.key,
      "适中：原理加一个示例",
    );
    expect(composer).toHaveValue("正在写的草稿");
  });

  it("新问题不替换当前问题，上一题与下一题交由父组件选择", () => {
    const second = { ...QUESTION, key: "item-2:0", title: "选择存储方式" };
    const panelProps = props();
    const { rerender } = render(<AsyncQuestionPanel {...panelProps} />);

    rerender(
      <AsyncQuestionPanel {...panelProps} questions={[QUESTION, second]} />,
    );

    expect(screen.getByRole("heading", { name: QUESTION.title })).toBeVisible();
    expect(screen.queryByText(second.title)).not.toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeVisible();
    expect(screen.getByRole("button", { name: "上一题" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    expect(panelProps.onSelect).toHaveBeenCalledWith(second.key);

    rerender(
      <AsyncQuestionPanel
        {...panelProps}
        questions={[QUESTION, second]}
        selectedKey={second.key}
      />,
    );

    expect(screen.getByRole("heading", { name: second.title })).toBeVisible();
    expect(screen.getByText("2 / 2")).toBeVisible();
    expect(screen.getByRole("button", { name: "下一题" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "上一题" }));
    expect(panelProps.onSelect).toHaveBeenLastCalledWith(QUESTION.key);
  });

  it("摘要支持折叠和再次展开，折叠不会忽略问题", async () => {
    const panelProps = props();
    const { rerender } = render(<AsyncQuestionPanel {...panelProps} />);
    const summary = screen.getByRole("button", { name: "待回答 · 1" });

    fireEvent.click(summary);
    expect(panelProps.onExpandedChange).toHaveBeenCalledWith(false);
    expect(panelProps.onIgnore).not.toHaveBeenCalled();

    rerender(<AsyncQuestionPanel {...panelProps} expanded={false} />);
    expect(summary).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => {
      expect(screen.getByText(QUESTION.title)).not.toBeVisible();
    });

    fireEvent.click(summary);
    expect(panelProps.onExpandedChange).toHaveBeenLastCalledWith(true);
    rerender(<AsyncQuestionPanel {...panelProps} expanded />);
    expect(screen.getByRole("button", { name: "简洁" })).toBeVisible();
  });

  it("发送中保留选项选择且禁用重复发送和忽略", () => {
    const panelProps = props({
      questions: [{ ...QUESTION, status: "sending", answer: "简洁" }],
    });
    render(<AsyncQuestionPanel {...panelProps} />);

    expect(screen.getByRole("button", { name: "简洁" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "简洁" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "详细" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "忽略此问题" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("发送中");
    fireEvent.click(screen.getByRole("button", { name: "简洁" }));
    expect(panelProps.onAnswer).not.toHaveBeenCalled();
  });

  it("失败保留答案与选项，结果不确定时仅由用户核对后显式重试", () => {
    const panelProps = props({
      questions: [{
        ...QUESTION,
        status: "uncertain",
        answer: "简洁",
        error: "发送结果未确认，请检查聊天记录后再重试",
      }],
    });
    render(<AsyncQuestionPanel {...panelProps} />);

    expect(screen.getByText("发送结果未确认，请检查聊天记录后再重试"))
      .toBeVisible();
    expect(screen.getByRole("button", { name: "简洁" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(panelProps.onAnswer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "简洁" }));
    expect(panelProps.onAnswer).toHaveBeenCalledExactlyOnceWith(
      QUESTION.key,
      "简洁",
    );
  });

  it("自定义回答保留原文，输入法 Enter 不发送，显式发送按钮提交", () => {
    const panelProps = props();
    const { rerender } = render(<AsyncQuestionPanel {...panelProps} />);

    fireEvent.click(screen.getByRole("button", { name: "自定义回答" }));
    expect(panelProps.onCustomAnswerChange)
      .toHaveBeenCalledExactlyOnceWith(QUESTION.key, true);

    const customQuestion = { ...QUESTION, customAnswer: true };
    rerender(<AsyncQuestionPanel {...panelProps} questions={[customQuestion]} />);
    const textarea = screen.getByRole("textbox", { name: "自定义回答" });
    expect(screen.getByRole("button", { name: "发送回答" })).toBeDisabled();

    const draft = " 自己的答案\n保留格式 ";
    fireEvent.change(textarea, { target: { value: draft } });
    expect(panelProps.onDraftChange).toHaveBeenCalledWith(QUESTION.key, draft);
    rerender(
      <AsyncQuestionPanel
        {...panelProps}
        questions={[{ ...customQuestion, draft }]}
      />,
    );

    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(panelProps.onAnswer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "发送回答" }));
    expect(panelProps.onAnswer).toHaveBeenCalledExactlyOnceWith(QUESTION.key, draft);
    fireEvent.click(screen.getByRole("button", { name: "收起自定义回答" }));
    expect(panelProps.onCustomAnswerChange)
      .toHaveBeenLastCalledWith(QUESTION.key, false);
  });

  it("无选项的问题直接提供自定义输入，禁用发送时仍可编辑和忽略", () => {
    const panelProps = props({
      disabled: true,
      selectedKey: null,
      questions: [{ ...QUESTION, options: null, draft: "我的答案" }],
    });
    render(<AsyncQuestionPanel {...panelProps} />);

    expect(screen.getByRole("textbox", { name: "自定义回答" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "发送回答" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "忽略此问题" }));
    expect(panelProps.onIgnore).toHaveBeenCalledExactlyOnceWith(QUESTION.key);
    expect(panelProps.onAnswer).not.toHaveBeenCalled();
  });

  it("没有待答题时隐藏面板，但仍展示可重试的状态存储错误", () => {
    const panelProps = props({ questions: [], expanded: false });
    const { rerender } = render(
      <ComposerAccessoryPanel>
        <AsyncQuestionPanel {...panelProps} />
      </ComposerAccessoryPanel>,
    );
    expect(document.querySelector("[data-composer-accessory-panel]"))
      .not.toBeVisible();

    rerender(
      <ComposerAccessoryPanel>
        <AsyncQuestionPanel {...panelProps} error="无法保存问题处理记录" />
      </ComposerAccessoryPanel>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("无法保存问题处理记录");
    expect(screen.getByRole("status")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(panelProps.onRetry).toHaveBeenCalledTimes(1);
    expect(panelProps.onAnswer).not.toHaveBeenCalled();
  });
});
