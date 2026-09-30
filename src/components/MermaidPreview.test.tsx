import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderMermaid } from "../content/mermaid";
import { MermaidPreview } from "./MermaidPreview";
import { useModalLayer } from "./modalStack";

vi.mock("../content/mermaid", () => ({ renderMermaid: vi.fn() }));

const source = "flowchart LR\n  A --> B";
const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>图表</text></svg>";
const renderMock = vi.mocked(renderMermaid);

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function OtherModal() {
  useModalLayer();
  return null;
}

describe("MermaidPreview", () => {
  let media: EventTarget & { matches: boolean };
  const revokeUrl = vi.fn();

  beforeEach(() => {
    media = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    let nextUrl = 0;
    revokeUrl.mockReset();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL(blob: Blob) { return `blob:mermaid-${blob.size}-${++nextUrl}`; }
      static revokeObjectURL = revokeUrl;
    });
    delete document.documentElement.dataset.theme;
    renderMock.mockReset();
    renderMock.mockResolvedValue(svg);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.theme;
  });

  it("生成期间提示状态，完成后仅以 SVG 图片显示", async () => {
    const pending = deferred();
    renderMock.mockReturnValue(pending.promise);
    const { container } = render(<MermaidPreview source={source} />);

    expect(screen.getByRole("status")).toHaveTextContent("正在生成图表");
    await act(async () => pending.resolve(svg));

    expect(screen.getByRole("img", { name: "Mermaid 图表" })).toHaveAttribute("src", `blob:mermaid-${new Blob([svg]).size}-1`);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("旧源码的异步结果不会覆盖新源码", async () => {
    const previous = deferred();
    const next = deferred();
    renderMock.mockReturnValueOnce(previous.promise).mockReturnValueOnce(next.promise);
    const { rerender } = render(<MermaidPreview source="flowchart LR; A-->B" />);
    rerender(<MermaidPreview source="flowchart LR; A-->C" />);

    const nextSvg = "<svg>new diagram</svg>";
    await act(async () => next.resolve(nextSvg));
    expect(screen.getByRole("img")).toHaveAttribute("src", `blob:mermaid-${new Blob([nextSvg]).size}-1`);

    await act(async () => previous.resolve("<svg>old</svg>"));
    expect(screen.getByRole("img")).toHaveAttribute("src", `blob:mermaid-${new Blob([nextSvg]).size}-1`);
  });

  it("更换源码时移除旧图并释放 URL，新结果拥有独立的图片地址", async () => {
    const next = deferred();
    renderMock.mockResolvedValueOnce(svg).mockReturnValueOnce(next.promise);
    const { rerender, unmount } = render(<MermaidPreview source={source} />);
    const previousUrl = (await screen.findByRole("img")).getAttribute("src");

    rerender(<MermaidPreview source="flowchart LR; X-->Y" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(revokeUrl).toHaveBeenCalledWith(previousUrl);

    await act(async () => next.resolve("<svg>next</svg>"));
    const nextUrl = screen.getByRole("img").getAttribute("src");
    expect(nextUrl).not.toBe(previousUrl);
    unmount();
    expect(revokeUrl).toHaveBeenCalledWith(nextUrl);
  });

  it("应用主题优先于系统主题，并在切换后重新生成", async () => {
    document.documentElement.dataset.theme = "light";
    media.matches = true;
    render(<MermaidPreview source={source} />);
    await screen.findByRole("img");
    expect(renderMock).toHaveBeenLastCalledWith(source, "light");

    await act(async () => { document.documentElement.dataset.theme = "dark"; });
    await waitFor(() => expect(renderMock).toHaveBeenLastCalledWith(source, "dark"));

    await act(async () => { delete document.documentElement.dataset.theme; });
    act(() => {
      media.matches = false;
      media.dispatchEvent(new Event("change"));
    });
    await waitFor(() => expect(renderMock).toHaveBeenLastCalledWith(source, "light"));
  });

  it("失败时明确提示并保留原源码", async () => {
    renderMock.mockRejectedValue(new Error("第 2 行语法错误"));
    render(<MermaidPreview source={source} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("图表生成失败：第 2 行语法错误");
    expect(screen.getByText(/flowchart LR/u, { selector: "code" }).textContent).toBe(source);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("放大弹窗使用独立图层，支持缩放、焦点循环和 Escape 后恢复焦点", async () => {
    const { container } = render(<MermaidPreview source={source} />);
    await screen.findByRole("img");
    const trigger = screen.getByRole("button", { name: "放大查看" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Mermaid 图表" });
    expect(container).not.toContainElement(dialog);
    expect(screen.getByRole("button", { name: "关闭图表预览" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "放大图表" }));
    expect(within(dialog).getByRole("img")).toHaveStyle({ width: "125%" });
    fireEvent.click(screen.getByRole("button", { name: "缩小图表" }));
    expect(within(dialog).getByRole("img")).toHaveStyle({ width: "100%" });

    const canvas = screen.getByRole("region", { name: "图表查看区域" });
    canvas.focus();
    fireEvent.keyDown(canvas, { key: "Tab" });
    const first = screen.getByRole("button", { name: "缩小图表" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(canvas).toHaveFocus();

    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("主题更新期间保留弹窗、缩放和焦点，不显示上一主题的图片", async () => {
    const dark = deferred();
    renderMock.mockResolvedValueOnce(svg).mockReturnValueOnce(dark.promise);
    render(<MermaidPreview source={source} />);
    await screen.findByRole("img");
    const trigger = screen.getByRole("button", { name: "放大查看" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "放大图表" }));
    const dialog = screen.getByRole("dialog");
    const previousUrl = within(dialog).getByRole("img").getAttribute("src");
    const canvas = screen.getByRole("region", { name: "图表查看区域" });
    canvas.focus();

    await act(async () => { document.documentElement.dataset.theme = "dark"; });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByText("正在生成图表…")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(canvas).toHaveFocus();

    await act(async () => dark.resolve("<svg>dark</svg>"));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByRole("img")).toHaveStyle({ width: "125%" });
    expect(within(dialog).getByRole("img")).not.toHaveAttribute("src", previousUrl);
    expect(canvas).toHaveFocus();

    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(trigger).toHaveFocus();
  });

  it.each(["已处理", "输入法合成", "长按重复"])("%s的 Escape 不关闭图表", async (reason) => {
    render(<MermaidPreview source={source} />);
    fireEvent.click(await screen.findByRole("button", { name: "放大查看" }));
    const event = new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
      isComposing: reason === "输入法合成", repeat: reason === "长按重复",
    });
    if (reason === "已处理") event.preventDefault();
    fireEvent(screen.getByRole("dialog"), event);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("上层弹窗存在时不响应 Escape", async () => {
    const { rerender } = render(<><MermaidPreview source={source} /></>);
    fireEvent.click(await screen.findByRole("button", { name: "放大查看" }));
    rerender(<><MermaidPreview source={source} /><OtherModal /></>);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
