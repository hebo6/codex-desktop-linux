import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AsyncQuestionMessage } from "./AsyncQuestionMessage";

const QUESTIONS = [
  { title: "你希望怎么讲解？", options: ["简洁", "适中：原理加一个示例"] },
  { title: "使用哪个数据库？", options: ["SQLite", "PostgreSQL"] },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("AsyncQuestionMessage", () => {
  it("在消息中完整显示多道问题，出现时不抢输入框焦点", () => {
    const { rerender } = render(
      <>
        <textarea aria-label="任务输入" defaultValue="未发送草稿" />
        <AsyncQuestionMessage disabled={false} questions={[]} />
      </>,
    );
    const composer = screen.getByRole("textbox", { name: "任务输入" });
    composer.focus();

    rerender(
      <>
        <textarea aria-label="任务输入" defaultValue="未发送草稿" />
        <AsyncQuestionMessage disabled={false} questions={QUESTIONS} />
      </>,
    );

    expect(composer).toHaveFocus();
    for (const question of QUESTIONS) {
      expect(screen.getByRole("heading", { name: question.title })).toBeVisible();
    }
    expect(screen.queryByRole("button", { name: "下一题" })).not.toBeInTheDocument();
    expect(screen.queryByText(/待回答/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "忽略此问题" })).not.toBeInTheDocument();
  });

  it("选项可通过键盘原样发送，发送后不保留已选状态且可再次点击", async () => {
    const user = userEvent.setup();
    const onReply = vi.fn(async () => true);
    const optionText = "  适中：原理加一个示例\n保留格式  ";
    render(
      <AsyncQuestionMessage
        disabled={false}
        onReply={onReply}
        questions={[{ title: "讲解方式", options: [optionText] }]}
      />,
    );
    const option = screen.getByRole("button", { name: /适中：原理加一个示例/u });
    option.focus();
    await user.keyboard("{Enter}");

    expect(onReply).toHaveBeenCalledExactlyOnceWith(optionText);
    expect(option).toBeEnabled();
    expect(option).not.toHaveAttribute("aria-pressed");
    expect(screen.getByRole("heading", { name: "讲解方式" })).toBeVisible();

    await user.click(option);
    expect(onReply).toHaveBeenCalledTimes(2);
    expect(onReply).toHaveBeenLastCalledWith(optionText);
  });

  it("同一事件循环点击多个问题只提交一次，发送期间暂时禁用所有回复", async () => {
    const pending = deferred<boolean>();
    const onReply = vi.fn(() => pending.promise);
    render(<AsyncQuestionMessage disabled={false} onReply={onReply} questions={QUESTIONS} />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "简洁" }));
      fireEvent.click(screen.getByRole("button", { name: "PostgreSQL" }));
    });

    expect(onReply).toHaveBeenCalledExactlyOnceWith("简洁");
    expect(screen.getByRole("button", { name: "简洁" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "PostgreSQL" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("发送中");

    await act(async () => pending.resolve(true));
    expect(screen.getByRole("button", { name: "PostgreSQL" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["false", "throw"])("发送返回 %s 后保留选项，由用户显式重试", async (outcome) => {
    const onReply = vi.fn(async () => {
      if (outcome === "throw") throw new Error("connection unavailable");
      return false;
    });
    render(<AsyncQuestionMessage disabled={false} onReply={onReply} questions={QUESTIONS} />);

    fireEvent.click(screen.getByRole("button", { name: "简洁" }));
    await waitFor(() => {
      expect(screen.getByRole("status"))
        .toHaveTextContent("发送结果未确认，请检查聊天记录后再重试");
    });
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "简洁" })).toBeEnabled();

    onReply.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "简洁" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(onReply).toHaveBeenCalledTimes(2);
  });

  it("自定义回复保留空白和换行，IME Enter 不发送，成功只清空该题草稿", async () => {
    const user = userEvent.setup();
    const onReply = vi.fn(async () => true);
    render(<AsyncQuestionMessage disabled={false} onReply={onReply} questions={QUESTIONS} />);
    const first = screen.getByRole("region", { name: QUESTIONS[0]!.title });
    const second = screen.getByRole("region", { name: QUESTIONS[1]!.title });
    await user.click(within(first).getByRole("button", { name: "自定义回复" }));
    await user.click(within(second).getByRole("button", { name: "自定义回复" }));

    const firstDraft = within(first).getByRole("textbox", { name: "自定义回复" });
    const secondDraft = within(second).getByRole("textbox", { name: "自定义回复" });
    expect(within(first).getByRole("button", { name: "发送回复" })).toBeDisabled();
    fireEvent.change(firstDraft, { target: { value: "  原始回复\n保留格式  " } });
    fireEvent.change(secondDraft, { target: { value: "另一题草稿" } });
    fireEvent.compositionStart(firstDraft);
    fireEvent.keyDown(firstDraft, { key: "Enter", isComposing: true });
    fireEvent.compositionEnd(firstDraft);
    fireEvent.keyDown(firstDraft, { key: "Enter" });
    expect(onReply).not.toHaveBeenCalled();

    await user.click(within(first).getByRole("button", { name: "发送回复" }));
    expect(onReply).toHaveBeenCalledExactlyOnceWith("  原始回复\n保留格式  ");
    expect(firstDraft).toHaveValue("");
    expect(secondDraft).toHaveValue("另一题草稿");
    expect(within(first).getByRole("button", { name: "简洁" })).toBeEnabled();
  });

  it("没有选项时直接提供自定义回复，发送失败保留草稿", async () => {
    const onReply = vi.fn(async () => false);
    render(
      <AsyncQuestionMessage
        disabled={false}
        onReply={onReply}
        questions={[{ title: "还有什么需要补充？", options: null }]}
      />,
    );
    const draft = screen.getByRole("textbox", { name: "自定义回复" });
    fireEvent.change(draft, { target: { value: "补充内容" } });
    fireEvent.click(screen.getByRole("button", { name: "发送回复" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("发送结果未确认"));
    expect(draft).toHaveValue("补充内容");
    expect(screen.getByRole("button", { name: "发送回复" })).toBeEnabled();
  });

  it("不可发送或没有回复处理器时保留问题但禁用发送", async () => {
    const onReply = vi.fn(async () => true);
    const { rerender } = render(
      <AsyncQuestionMessage disabled onReply={onReply} questions={QUESTIONS} />,
    );
    expect(screen.getByRole("button", { name: "简洁" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "简洁" }));
    expect(onReply).not.toHaveBeenCalled();

    rerender(<AsyncQuestionMessage disabled={false} questions={QUESTIONS} />);
    expect(screen.getByRole("button", { name: "简洁" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: QUESTIONS[0]!.title })).toBeVisible();
  });
});
