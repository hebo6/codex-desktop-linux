import {
  forwardRef,
  useMemo,
  type CSSProperties,
  type UIEventHandler,
} from "react";

import {
  parseAnsiOutput,
  type AnsiColor,
  type AnsiTextStyle,
} from "../content/ansiOutput";
import styles from "./AnsiCommandOutput.module.css";

export interface AnsiCommandOutputProps {
  readonly "aria-label"?: string;
  readonly className?: string;
  readonly onScroll?: UIEventHandler<HTMLElement>;
  readonly output: string;
}

export const AnsiCommandOutput = forwardRef<
  HTMLElement,
  AnsiCommandOutputProps
>(function AnsiCommandOutput(
  {
    "aria-label": ariaLabel,
    className,
    onScroll,
    output,
  },
  ref,
) {
  const tokens = useMemo(() => parseAnsiOutput(output), [output]);
  return (
    <samp
      {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
      className={`${styles.output}${className === undefined ? "" : ` ${className}`}`}
      {...(onScroll === undefined ? {} : { onScroll })}
      ref={ref}
    >
      {tokens.map((token, index) => {
        const styled = hasStyle(token.style);
        return styled ? (
          <span
            data-ansi-bold={token.style.bold}
            data-ansi-dim={token.style.dim}
            data-ansi-italic={token.style.italic}
            data-ansi-strikethrough={token.style.strikethrough}
            data-ansi-underline={token.style.underline}
            key={index}
            style={tokenCss(token.style)}
          >
            {token.text}
          </span>
        ) : token.text;
      })}
    </samp>
  );
});

function hasStyle(style: AnsiTextStyle): boolean {
  return style.background !== null ||
    style.bold ||
    style.dim ||
    style.foreground !== null ||
    style.inverse ||
    style.italic ||
    style.strikethrough ||
    style.underline;
}

function tokenCss(style: AnsiTextStyle): CSSProperties | undefined {
  let foreground = style.foreground === null
    ? undefined
    : colorCss(style.foreground, "foreground");
  let background = style.background === null
    ? undefined
    : colorCss(style.background, "background");
  if (style.inverse) {
    [foreground, background] = [
      background ?? "var(--ansi-default-background)",
      foreground ?? "var(--ansi-default-foreground)",
    ];
  }
  if (foreground === undefined && background === undefined) {
    return undefined;
  }
  return {
    ...(background === undefined ? {} : { backgroundColor: background }),
    ...(foreground === undefined ? {} : { color: foreground }),
  };
}

function colorCss(
  color: AnsiColor,
  usage: "background" | "foreground",
): string {
  if (color.kind === "rgb") {
    return `rgb(${color.red} ${color.green} ${color.blue})`;
  }
  if (color.kind === "basic") {
    if (usage === "foreground" && (color.index === 0 || color.index === 7 || color.index === 15)) {
      return `var(--ansi-foreground-${color.index})`;
    }
    return `var(--ansi-color-${color.index})`;
  }
  const [red, green, blue] = indexedRgb(color.index);
  return `rgb(${red} ${green} ${blue})`;
}

function indexedRgb(index: number): readonly [number, number, number] {
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return [level, level, level];
  }
  const offset = index - 16;
  const red = Math.floor(offset / 36);
  const green = Math.floor((offset % 36) / 6);
  const blue = offset % 6;
  return [colorLevel(red), colorLevel(green), colorLevel(blue)];
}

function colorLevel(value: number): number {
  return value === 0 ? 0 : 55 + value * 40;
}
