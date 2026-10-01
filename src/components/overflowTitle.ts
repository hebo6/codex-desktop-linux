import type { SyntheticEvent } from "react";

function updateOverflowTitle({ currentTarget }: SyntheticEvent<HTMLElement>): void {
  currentTarget.title = currentTarget.scrollWidth > currentTarget.clientWidth
    ? currentTarget.textContent ?? ""
    : "";
}

// 在交互时测量，避免为每个文字行持续监听尺寸变化
export const overflowTitleProps = {
  onMouseEnter: updateOverflowTitle,
  onFocus: updateOverflowTitle,
};
