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

interface MutableAnsiTextToken {
  style: AnsiTextStyle;
  text: string;
}

type ParserMode =
  | "controlString"
  | "controlStringEscape"
  | "csi"
  | "escape"
  | "escapeSequence"
  | "text";

const DEFAULT_STYLE: AnsiTextStyle = Object.freeze({
  background: null,
  bold: false,
  dim: false,
  foreground: null,
  inverse: false,
  italic: false,
  strikethrough: false,
  underline: false,
});

const ESCAPE = 0x1b;
const DELETE = 0x7f;
const C1_CONTROL_START = 0x80;
const C1_CONTROL_END = 0x9f;
const C1_DEVICE_CONTROL_STRING = 0x90;
const C1_START_OF_STRING = 0x98;
const C1_CONTROL_SEQUENCE_INTRODUCER = 0x9b;
const C1_STRING_TERMINATOR = 0x9c;
const C1_OPERATING_SYSTEM_COMMAND = 0x9d;
const C1_PRIVACY_MESSAGE = 0x9e;
const C1_APPLICATION_PROGRAM_COMMAND = 0x9f;
const BELL = 0x07;
const MAX_CSI_PARAMETER_LENGTH = 256;

export function parseAnsiOutput(source: string): readonly AnsiTextToken[] {
  return new AnsiParser().parse(source);
}

class AnsiParser {
  readonly #tokens: MutableAnsiTextToken[] = [];
  #csiParameters = "";
  #mode: ParserMode = "text";
  #skipLineFeed = false;
  #style: AnsiTextStyle = DEFAULT_STYLE;

  parse(source: string): readonly AnsiTextToken[] {
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index] ?? "";
      const code = source.charCodeAt(index);

      switch (this.#mode) {
        case "text":
          this.#consumeText(character, code);
          break;
        case "escape":
          if (character === "[") {
            this.#startCsi();
          } else if (
            character === "]" ||
            character === "P" ||
            character === "X" ||
            character === "^" ||
            character === "_"
          ) {
            this.#mode = "controlString";
          } else if (isEscapeIntermediate(code)) {
            this.#mode = "escapeSequence";
          } else if (isEscapeFinal(code)) {
            this.#mode = "text";
          } else if (code !== ESCAPE) {
            this.#mode = "text";
            index -= 1;
          }
          break;
        case "escapeSequence":
          if (isEscapeFinal(code)) {
            this.#mode = "text";
          } else if (!isEscapeIntermediate(code)) {
            this.#mode = "text";
            index -= 1;
          }
          break;
        case "csi":
          if (isCsiFinal(code)) {
            if (character === "m") {
              this.#applySgr(this.#csiParameters);
            }
            this.#csiParameters = "";
            this.#mode = "text";
          } else if (isCsiParameterOrIntermediate(code)) {
            if (this.#csiParameters.length < MAX_CSI_PARAMETER_LENGTH) {
              this.#csiParameters += character;
            }
          } else if (code === ESCAPE) {
            this.#csiParameters = "";
            this.#mode = "escape";
          } else {
            this.#csiParameters = "";
            this.#mode = "text";
            index -= 1;
          }
          break;
        case "controlString":
          if (code === BELL || code === C1_STRING_TERMINATOR) {
            this.#mode = "text";
          } else if (code === ESCAPE) {
            this.#mode = "controlStringEscape";
          }
          break;
        case "controlStringEscape":
          if (character === "\\" || code === C1_STRING_TERMINATOR || code === BELL) {
            this.#mode = "text";
          } else if (code !== ESCAPE) {
            this.#mode = "controlString";
          }
          break;
      }
    }

    return this.#tokens;
  }

  #consumeText(character: string, code: number) {
    if (this.#skipLineFeed) {
      this.#skipLineFeed = false;
      if (character === "\n") {
        return;
      }
    }

    if (code === ESCAPE) {
      this.#mode = "escape";
      return;
    }
    if (code === C1_CONTROL_SEQUENCE_INTRODUCER) {
      this.#startCsi();
      return;
    }
    if (
      code === C1_DEVICE_CONTROL_STRING ||
      code === C1_START_OF_STRING ||
      code === C1_OPERATING_SYSTEM_COMMAND ||
      code === C1_PRIVACY_MESSAGE ||
      code === C1_APPLICATION_PROGRAM_COMMAND
    ) {
      this.#mode = "controlString";
      return;
    }
    if (character === "\r") {
      this.#appendText("\n");
      this.#skipLineFeed = true;
      return;
    }
    if (character === "\n" || character === "\t") {
      this.#appendText(character);
      return;
    }
    if (
      code < 0x20 ||
      code === DELETE ||
      (code >= C1_CONTROL_START && code <= C1_CONTROL_END)
    ) {
      return;
    }
    this.#appendText(character);
  }

  #startCsi() {
    this.#csiParameters = "";
    this.#mode = "csi";
  }

  #appendText(text: string) {
    const previous = this.#tokens[this.#tokens.length - 1];
    if (previous !== undefined && sameStyle(previous.style, this.#style)) {
      previous.text += text;
      return;
    }
    this.#tokens.push({
      style: this.#style,
      text,
    });
  }

  #applySgr(parameters: string) {
    if (parameters.length === 0) {
      this.#style = DEFAULT_STYLE;
      return;
    }

    const fields = parameters.split(";");
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index] ?? "";
      if (field.includes(":")) {
        this.#applyColonSgr(field);
        continue;
      }

      const code = sgrNumber(field, 0);
      if (code === null) {
        continue;
      }
      if (code === 38 || code === 48) {
        const parsed = extendedSemicolonColor(fields, index);
        if (parsed !== null) {
          this.#setColor(code, parsed.color);
          index = parsed.lastIndex;
        }
        continue;
      }
      this.#applySimpleSgr(code);
    }
  }

  #applyColonSgr(field: string) {
    const values = field.split(":").map((value) => sgrNumber(value, null));
    const code = values[0];
    if (code === 4) {
      this.#style = {
        ...this.#style,
        underline: values[1] !== 0,
      };
      return;
    }
    if (code !== 38 && code !== 48) {
      if (code !== null && code !== undefined) {
        this.#applySimpleSgr(code);
      }
      return;
    }

    const mode = values[1];
    if (mode === 5) {
      const index = byte(values[values.length - 1]);
      if (index !== null) {
        this.#setColor(code, indexedColor(index));
      }
      return;
    }
    if (mode === 2) {
      const red = byte(values[values.length - 3]);
      const green = byte(values[values.length - 2]);
      const blue = byte(values[values.length - 1]);
      if (red !== null && green !== null && blue !== null) {
        this.#setColor(code, { blue, green, kind: "rgb", red });
      }
    }
  }

  #applySimpleSgr(code: number) {
    if (code >= 30 && code <= 37) {
      this.#setColor(38, { index: code - 30, kind: "basic" });
      return;
    }
    if (code >= 40 && code <= 47) {
      this.#setColor(48, { index: code - 40, kind: "basic" });
      return;
    }
    if (code >= 90 && code <= 97) {
      this.#setColor(38, { index: code - 90 + 8, kind: "basic" });
      return;
    }
    if (code >= 100 && code <= 107) {
      this.#setColor(48, { index: code - 100 + 8, kind: "basic" });
      return;
    }

    switch (code) {
      case 0:
        this.#style = DEFAULT_STYLE;
        break;
      case 1:
        this.#style = { ...this.#style, bold: true };
        break;
      case 2:
        this.#style = { ...this.#style, dim: true };
        break;
      case 3:
        this.#style = { ...this.#style, italic: true };
        break;
      case 4:
      case 21:
        this.#style = { ...this.#style, underline: true };
        break;
      case 7:
        this.#style = { ...this.#style, inverse: true };
        break;
      case 9:
        this.#style = { ...this.#style, strikethrough: true };
        break;
      case 22:
        this.#style = { ...this.#style, bold: false, dim: false };
        break;
      case 23:
        this.#style = { ...this.#style, italic: false };
        break;
      case 24:
        this.#style = { ...this.#style, underline: false };
        break;
      case 27:
        this.#style = { ...this.#style, inverse: false };
        break;
      case 29:
        this.#style = { ...this.#style, strikethrough: false };
        break;
      case 39:
        this.#style = { ...this.#style, foreground: null };
        break;
      case 49:
        this.#style = { ...this.#style, background: null };
        break;
    }
  }

  #setColor(code: 38 | 48, color: AnsiColor) {
    this.#style = code === 38
      ? { ...this.#style, foreground: color }
      : { ...this.#style, background: color };
  }
}

function extendedSemicolonColor(
  fields: readonly string[],
  codeIndex: number,
): { readonly color: AnsiColor; readonly lastIndex: number } | null {
  const mode = sgrNumber(fields[codeIndex + 1] ?? "", null);
  if (mode === 5) {
    const index = byte(sgrNumber(fields[codeIndex + 2] ?? "", null));
    return index === null
      ? null
      : { color: indexedColor(index), lastIndex: codeIndex + 2 };
  }
  if (mode !== 2) {
    return null;
  }

  const red = byte(sgrNumber(fields[codeIndex + 2] ?? "", null));
  const green = byte(sgrNumber(fields[codeIndex + 3] ?? "", null));
  const blue = byte(sgrNumber(fields[codeIndex + 4] ?? "", null));
  return red === null || green === null || blue === null
    ? null
    : {
        color: { blue, green, kind: "rgb", red },
        lastIndex: codeIndex + 4,
      };
}

function indexedColor(index: number): AnsiColor {
  return index < 16
    ? { index, kind: "basic" }
    : { index, kind: "indexed" };
}

function sgrNumber(value: string, empty: number | null): number | null {
  if (value.length === 0) {
    return empty;
  }
  if (!/^\d+$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function byte(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && value >= 0 && value <= 255
    ? value
    : null;
}

function sameStyle(left: AnsiTextStyle, right: AnsiTextStyle): boolean {
  return left === right ||
    (
      left.background === right.background &&
      left.bold === right.bold &&
      left.dim === right.dim &&
      left.foreground === right.foreground &&
      left.inverse === right.inverse &&
      left.italic === right.italic &&
      left.strikethrough === right.strikethrough &&
      left.underline === right.underline
    );
}

function isEscapeIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}

function isEscapeFinal(code: number): boolean {
  return code >= 0x30 && code <= 0x7e;
}

function isCsiParameterOrIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x3f;
}

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}
