import type { Root } from "mdast";
import type { Extension as FromMarkdownExtension, Handle } from "mdast-util-from-markdown";
import type { Code, Construct, Extension, State, Tokenizer } from "micromark-util-types";
import type { Plugin } from "unified";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    latexMathInline: "latexMathInline";
    latexMathFlow: "latexMathFlow";
    latexMathLiteral: "latexMathLiteral";
    latexMathData: "latexMathData";
  }
}

const backslash = 92;
const space = 32;
const tab = -2;
const virtualSpace = -1;
const isLineEnding = (code: Code) => code === -3 || code === -4 || code === -5;
const isSpace = (code: Code) => code === space || code === tab || code === virtualSpace;

// 分隔符由 Markdown 词法层识别，代码、转义和容器边界仍由标准解析器处理
export const remarkMathDelimiters: Plugin<[], Root> = function () {
  const data = this.data();
  const syntax: Extension = {
    flow: { [backslash]: { tokenize: mathTokenizer(true), concrete: true, name: "latexMathFlow" } },
    text: {
      [backslash]: [
        { tokenize: mathTokenizer(false), name: "latexMathInline" },
        { tokenize: tokenizeLiteral, name: "latexMathLiteral" },
      ],
    },
  };
  const fromMarkdown: FromMarkdownExtension = {
    enter: {
      latexMathInline: enterMath,
      latexMathFlow: enterMath,
      latexMathLiteral: enterLiteral,
    },
    exit: {
      latexMathInline: exitMath,
      latexMathFlow: exitMath,
      latexMathLiteral: exitToken,
    },
  };
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
};

function mathTokenizer(display: boolean): Tokenizer {
  return function (effects, ok, nok) {
    const context = this;
    const tokenType = display ? "latexMathFlow" : "latexMathInline";
    const opening = display ? 91 : 40;
    const closing = display ? 93 : 41;
    const lineEnd: Construct = { tokenize: tokenizeLineEnd, partial: true };

    return start;

    function start(code: Code): State | undefined {
      effects.enter(tokenType);
      effects.enter("latexMathData");
      effects.consume(code);
      return open;
    }

    function open(code: Code): State | undefined {
      if (code !== opening) return nok(code);
      effects.consume(code);
      return content;
    }

    function content(code: Code): State | undefined {
      // 缺少闭合符时回滚，交给字面分隔符 token 保留流式源码
      if (code === null) return nok(code);
      if (isLineEnding(code)) {
        effects.exit("latexMathData");
        effects.enter("lineEnding");
        effects.consume(code);
        effects.exit("lineEnding");
        return lineStart;
      }
      effects.consume(code);
      if (code === backslash) return afterBackslash;
      return content;
    }

    function lineStart(code: Code): State | undefined {
      if (display && context.parser.lazy[context.now().line]) return nok(code);
      if (code === null) return nok(code);
      if (isLineEnding(code)) {
        effects.enter("lineEnding");
        effects.consume(code);
        effects.exit("lineEnding");
        return lineStart;
      }
      effects.enter("latexMathData");
      return content(code);
    }

    function afterBackslash(code: Code): State | undefined {
      if (code === closing) {
        effects.consume(code);
        return display ? effects.check(lineEnd, finish, content) : finish;
      }
      // 成对反斜杠属于公式本身，不能把第二个反斜杠误认成闭合符
      if (code === backslash) {
        effects.consume(code);
        return content;
      }
      return content(code);
    }

    function finish(code: Code): State | undefined {
      effects.exit("latexMathData");
      effects.exit(tokenType);
      if (!display || !isSpace(code)) return ok(code);
      effects.enter("whitespace");
      return trailingSpace(code);
    }

    function trailingSpace(code: Code): State | undefined {
      if (isSpace(code)) {
        effects.consume(code);
        return trailingSpace;
      }
      effects.exit("whitespace");
      return ok(code);
    }
  };
}

const tokenizeLineEnd: Tokenizer = function (effects, ok, nok) {
  return check;

  function check(code: Code): State | undefined {
    if (isSpace(code)) {
      effects.consume(code);
      return check;
    }
    return code === null || isLineEnding(code) ? ok(code) : nok(code);
  }
};

const tokenizeLiteral: Tokenizer = function (effects, ok, nok) {
  return start;

  function start(code: Code): State | undefined {
    effects.enter("latexMathLiteral");
    effects.consume(code);
    return delimiter;
  }

  function delimiter(code: Code): State | undefined {
    if (code !== 40 && code !== 41 && code !== 91 && code !== 93) return nok(code);
    effects.consume(code);
    effects.exit("latexMathLiteral");
    return ok;
  }
};

const enterMath: Handle = function (token) {
  const display = token.type === "latexMathFlow";
  const source = this.sliceSerialize(token).slice(2, -2);
  const value = display ? source.trim() : source.replace(/\r\n|\r|\n/g, " ");
  const code = {
    type: "element" as const,
    tagName: "code",
    properties: { className: ["language-math", display ? "math-display" : "math-inline"] },
    children: [{ type: "text" as const, value }],
  };
  this.enter(display ? {
    type: "math",
    value,
    data: { hName: "pre", hChildren: [code] },
  } : {
    type: "inlineMath",
    value,
    data: { hName: "code", hProperties: code.properties, hChildren: code.children },
  }, token);
  this.buffer();
};

const exitMath: Handle = function (token) {
  this.resume();
  this.exit(token);
};

const enterLiteral: Handle = function (token) {
  this.enter({ type: "text", value: this.sliceSerialize(token) }, token);
};

const exitToken: Handle = function (token) {
  this.exit(token);
};
