import Anser from "anser";

export type AnsiColor =
  | { readonly kind: "basic"; readonly index: number }
  | { readonly kind: "indexed"; readonly index: number }
  | { readonly blue: number; readonly green: number; readonly kind: "rgb"; readonly red: number };

export interface AnsiTextStyle {
  readonly background: AnsiColor | null;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly foreground: AnsiColor | null;
  readonly inverse: boolean;
  readonly italic: boolean;
  readonly strikethrough: boolean;
  readonly underline: boolean;
}

export interface AnsiTextToken {
  readonly style: AnsiTextStyle;
  readonly text: string;
}

const BASIC_COLOR_INDEX = new Map([
  ["ansi-black", 0],
  ["ansi-red", 1],
  ["ansi-green", 2],
  ["ansi-yellow", 3],
  ["ansi-blue", 4],
  ["ansi-magenta", 5],
  ["ansi-cyan", 6],
  ["ansi-white", 7],
  ["ansi-bright-black", 8],
  ["ansi-bright-red", 9],
  ["ansi-bright-green", 10],
  ["ansi-bright-yellow", 11],
  ["ansi-bright-blue", 12],
  ["ansi-bright-magenta", 13],
  ["ansi-bright-cyan", 14],
  ["ansi-bright-white", 15],
]);

const CONTROL_STRING_SEQUENCE =
  /(?:\u001b(?:\]|P|X|\^|_)|[\u0090\u0098\u009d-\u009f])[\s\S]*?(?:\u0007|\u009c|\u001b\\)/gu;
const UNTERMINATED_CONTROL_STRING =
  /(?:\u001b(?:\]|P|X|\^|_)|[\u0090\u0098\u009d-\u009f])[\s\S]*$/gu;
const OTHER_ESCAPE_SEQUENCE =
  /\u001b(?!\[)(?:[\u0020-\u002f]*[\u0030-\u007e]|.)?/gu;
const INCOMPLETE_CSI = /\u001b\[[\u0020-\u003f]*$/gu;
const C0_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/gu;
const C1_CONTROL = /[\u0080-\u009f]/gu;
const COLON_SGR = /\u001b\[([\d:;]*)m/gu;

export function parseAnsiOutput(source: string): readonly AnsiTextToken[] {
  const entries = Anser.ansiToJson(sanitizeAnsiOutput(source), {
    remove_empty: true,
    use_classes: true,
  });
  const tokens: AnsiTextToken[] = [];
  for (const entry of entries) {
    const token = tokenFrom(entry);
    const previous = tokens[tokens.length - 1];
    if (previous !== undefined && sameStyle(previous.style, token.style)) {
      tokens[tokens.length - 1] = {
        style: previous.style,
        text: previous.text + token.text,
      };
    } else {
      tokens.push(token);
    }
  }
  return tokens;
}

function sanitizeAnsiOutput(source: string): string {
  return source
    .replaceAll("\u009b", "\u001b[")
    .replace(CONTROL_STRING_SEQUENCE, "")
    .replace(UNTERMINATED_CONTROL_STRING, "")
    .replace(COLON_SGR, (_sequence, parameters: string) =>
      `\u001b[${normalizeColonSgr(parameters)}m`
    )
    .replace(OTHER_ESCAPE_SEQUENCE, "")
    .replace(INCOMPLETE_CSI, "")
    .replace(C0_CONTROL, "")
    .replace(C1_CONTROL, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
}

function normalizeColonSgr(parameters: string): string {
  return parameters.split(";").map((field) => {
    if (!field.includes(":")) {
      return field;
    }
    const values = field.split(":");
    const code = values[0];
    const mode = values[1];
    if ((code === "38" || code === "48") && mode === "5") {
      return `${code};5;${values[values.length - 1] ?? ""}`;
    }
    if ((code === "38" || code === "48") && mode === "2") {
      return `${code};2;${values.slice(-3).join(";")}`;
    }
    if (code === "4") {
      return mode === "0" ? "24" : "4";
    }
    return values.join(";");
  }).join(";");
}

function tokenFrom(entry: AnserEntry): AnsiTextToken {
  const decorations = new Set(entry.decorations);
  let foreground = ansiColor(entry.fg, entry.fg_truecolor);
  let background = ansiColor(entry.bg, entry.bg_truecolor);
  const inverse = entry.isInverted === true;
  if (inverse) {
    [foreground, background] = [background, foreground];
    foreground = isBasicColor(foreground, 7) ? null : foreground;
    background = isBasicColor(background, 0) ? null : background;
  }
  return {
    style: {
      background,
      bold: decorations.has("bold"),
      dim: decorations.has("dim"),
      foreground,
      inverse,
      italic: decorations.has("italic"),
      strikethrough: decorations.has("strikethrough"),
      underline: decorations.has("underline"),
    },
    text: entry.content,
  };
}

type AnserEntry = Anser.AnserJsonEntry & {
  readonly isInverted?: boolean;
};

function ansiColor(
  className: string | null,
  trueColor: string | null,
): AnsiColor | null {
  if (className === null) {
    return null;
  }
  const basicIndex = BASIC_COLOR_INDEX.get(className);
  if (basicIndex !== undefined) {
    return { index: basicIndex, kind: "basic" };
  }
  if (className === "ansi-truecolor") {
    return rgbColor(trueColor);
  }
  const palette = /^ansi-palette-(\d{1,3})$/u.exec(className);
  if (palette === null) {
    return null;
  }
  const index = Number(palette[1]);
  return index >= 16 && index <= 255
    ? { index, kind: "indexed" }
    : null;
}

function rgbColor(value: string | null): AnsiColor | null {
  if (value === null) {
    return null;
  }
  const components = value.split(",").map((component) => Number(component.trim()));
  const red = components[0];
  const green = components[1];
  const blue = components[2];
  return components.length === 3 &&
      byte(red) &&
      byte(green) &&
      byte(blue)
    ? { blue, green, kind: "rgb", red }
    : null;
}

function isBasicColor(color: AnsiColor | null, index: number): boolean {
  return color?.kind === "basic" && color.index === index;
}

function byte(value: number | undefined): value is number {
  return value !== undefined &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 255;
}

function sameStyle(left: AnsiTextStyle, right: AnsiTextStyle): boolean {
  return left.bold === right.bold &&
    left.dim === right.dim &&
    left.inverse === right.inverse &&
    left.italic === right.italic &&
    left.strikethrough === right.strikethrough &&
    left.underline === right.underline &&
    sameColor(left.background, right.background) &&
    sameColor(left.foreground, right.foreground);
}

function sameColor(left: AnsiColor | null, right: AnsiColor | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "rgb" && right.kind === "rgb") {
    return left.red === right.red &&
      left.green === right.green &&
      left.blue === right.blue;
  }
  return left.kind !== "rgb" &&
    right.kind !== "rgb" &&
    left.index === right.index;
}
