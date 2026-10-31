import { extname } from "node:path";
import { parse, type ParserPlugin } from "@babel/parser";

export type CommentKind = "line" | "block";

export interface SourceComment {
  kind: CommentKind;
  text: string;
  value: string;
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface RemovalRange {
  start: number;
  end: number;
}

export interface ScanError {
  message: string;
  line?: number;
  column?: number;
}

export interface ScanResult {
  comments: SourceComment[];
  removals: RemovalRange[];
  errors: ScanError[];
}

export interface SourceOptions {
  filename?: string;
}

export interface RemoveResult {
  source: string;
  removed: number;
  comments: SourceComment[];
  errors: ScanError[];
}

interface BabelComment {
  type: string;
  value: string;
  start?: number | null;
  end?: number | null;
  loc?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  } | null;
}

interface BabelParseError {
  message: string;
  loc?: { line: number; column: number } | null;
}

interface AstNode {
  type?: unknown;
  start?: unknown;
  end?: unknown;
  expression?: AstNode;
  [key: string]: unknown;
}

const SKIPPED_AST_KEYS = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "comments",
  "tokens",
  "errors",
  "leadingComments",
  "trailingComments",
  "innerComments",
]);

const JS_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const JSX_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".tsx"]);

function pluginsFor(filename: string): ParserPlugin[] {
  const extension = extname(filename).toLowerCase();
  const isTypeScript = TS_EXTENSIONS.has(extension);
  const isJsx = JSX_EXTENSIONS.has(extension);

  const plugins: ParserPlugin[] = [
    ["decorators", { decoratorsBeforeExport: true }],
    "decoratorAutoAccessors",
    "importAttributes",
    "explicitResourceManagement",
  ];

  if (isTypeScript) {
    plugins.push(["typescript", { isTSX: isJsx }] as unknown as ParserPlugin);
  }

  if (isJsx) {
    plugins.push("jsx");
  }

  if (!isTypeScript && !JS_EXTENSIONS.has(extension) && extension !== "") {
    plugins.push("jsx");
  }

  return plugins;
}

function lineColumnAt(source: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;

  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "\n") {
      line += 1;
      lineStart = cursor + 1;
    }
  }

  return { line, column: index - lineStart };
}

function commentText(comment: BabelComment): string {
  if (comment.type === "CommentLine") {
    return `//${comment.value}`;
  }

  return `/*${comment.value}*/`;
}

function toScanError(error: BabelParseError): ScanError {
  const result: ScanError = { message: error.message };

  if (error.loc) {
    result.line = error.loc.line;
    result.column = error.loc.column + 1;
  }

  return result;
}

function walkAst(value: unknown, visit: (node: AstNode) => void): void {
  const seen = new Set<unknown>();
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();

    if (current === null || typeof current !== "object" || seen.has(current)) {
      continue;
    }

    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item);
      }
      continue;
    }

    const node = current as AstNode;

    if (typeof node.type === "string") {
      visit(node);
    }

    for (const [key, child] of Object.entries(node)) {
      if (!SKIPPED_AST_KEYS.has(key)) {
        stack.push(child);
      }
    }
  }
}

function findJsxCommentContainers(ast: unknown): RemovalRange[] {
  const containers: RemovalRange[] = [];

  walkAst(ast, (node) => {
    if (
      node.type === "JSXExpressionContainer" &&
      node.expression?.type === "JSXEmptyExpression" &&
      typeof node.start === "number" &&
      typeof node.end === "number"
    ) {
      containers.push({ start: node.start, end: node.end });
    }
  });

  return containers;
}

function containerForComment(
  comment: SourceComment,
  containers: RemovalRange[],
): RemovalRange | undefined {
  let best: RemovalRange | undefined;

  for (const container of containers) {
    if (comment.start >= container.start && comment.end <= container.end) {
      if (!best || container.end - container.start < best.end - best.start) {
        best = container;
      }
    }
  }

  return best;
}

function mergeRemovalRanges(source: string, ranges: RemovalRange[]): RemovalRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: RemovalRange[] = [];

  for (const range of sorted) {
    const previous = merged.at(-1);

    if (!previous) {
      merged.push({ ...range });
      continue;
    }

    const gap = source.slice(previous.end, range.start);
    const isAdjacent = range.start <= previous.end;
    const isWhitespaceGap = !gap.includes("\n") && gap.trim() === "";

    if (isAdjacent || isWhitespaceGap) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

export function scanSource(source: string, options: SourceOptions = {}): ScanResult {
  const filename = options.filename ?? "input.tsx";
  const plugins = pluginsFor(filename);

  let ast: unknown;
  let errors: ScanError[] = [];

  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      plugins,
      attachComment: false,
      errorRecovery: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
    });
  } catch (error) {
    const parseError = error as BabelParseError;
    return {
      comments: [],
      removals: [],
      errors: [toScanError(parseError)],
    };
  }

  const parsed = ast as {
    comments?: BabelComment[];
    errors?: BabelParseError[];
  };

  errors = (parsed.errors ?? []).map(toScanError);

  const comments: SourceComment[] = [];

  for (const comment of parsed.comments ?? []) {
    if (typeof comment.start !== "number" || typeof comment.end !== "number") {
      continue;
    }

    const startLocation =
      comment.loc?.start ?? lineColumnAt(source, comment.start);
    const endLocation =
      comment.loc?.end ?? lineColumnAt(source, comment.end);

    comments.push({
      kind: comment.type === "CommentLine" ? "line" : "block",
      text: commentText(comment),
      value: comment.value,
      start: comment.start,
      end: comment.end,
      line: startLocation.line,
      column: startLocation.column,
      endLine: endLocation.line,
      endColumn: endLocation.column,
    });
  }

  const containers = findJsxCommentContainers(ast);
  const targets = new Map<string, RemovalRange>();

  for (const comment of comments) {
    const target = containerForComment(comment, containers) ?? {
      start: comment.start,
      end: comment.end,
    };

    targets.set(`${target.start}:${target.end}`, target);
  }

  return {
    comments,
    removals: mergeRemovalRanges(source, [...targets.values()]),
    errors,
  };
}

function lineStartAt(source: string, index: number): number {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;

  if (lineStart === 0 && source.charCodeAt(0) === 0xfeff) {
    return 1;
  }

  return lineStart;
}

function lineBreakAt(source: string, index: number): number {
  return source.indexOf("\n", index);
}

function contentEndAt(source: string, index: number): number {
  const lineBreak = lineBreakAt(source, index);

  if (lineBreak === -1) {
    return source.length;
  }

  if (lineBreak > 0 && source[lineBreak - 1] === "\r") {
    return lineBreak - 1;
  }

  return lineBreak;
}

function isHorizontalWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

function isOpeningDelimiter(character: string | undefined): boolean {
  return character === "(" || character === "[" || character === "{";
}

function isClosingDelimiter(character: string | undefined): boolean {
  return character === ")" || character === "]" || character === "}" || character === ";" || character === ",";
}

function needsSeparator(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) {
    return false;
  }

  if (isIdentifierCharacter(left) && isIdentifierCharacter(right)) {
    return true;
  }

  if ((left === "+" || left === "-") && right === left) {
    return true;
  }

  if (left === "/" && (right === "/" || right === "*")) {
    return true;
  }

  return left === "*" && right === "/";
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function buildEdit(source: string, range: RemovalRange): Edit {
  const lineStart = lineStartAt(source, range.start);
  const lineBreak = lineBreakAt(source, range.end);
  const contentEnd = contentEndAt(source, range.end);
  const hasCodeBefore = source.slice(lineStart, range.start).trim() !== "";
  const hasCodeAfter = source.slice(range.end, contentEnd).trim() !== "";

  if (!hasCodeBefore && !hasCodeAfter) {
    return {
      start: lineStart,
      end: lineBreak === -1 ? source.length : lineBreak + 1,
      text: "",
    };
  }

  if (!hasCodeBefore) {
    let right = range.end;

    while (right < contentEnd && isHorizontalWhitespace(source[right])) {
      right += 1;
    }

    return { start: range.start, end: right, text: "" };
  }

  if (!hasCodeAfter) {
    let left = range.start;

    while (left > lineStart && isHorizontalWhitespace(source[left - 1])) {
      left -= 1;
    }

    return { start: left, end: range.end, text: "" };
  }

  let left = range.start;
  let right = range.end;

  while (left > lineStart && isHorizontalWhitespace(source[left - 1])) {
    left -= 1;
  }

  while (right < contentEnd && isHorizontalWhitespace(source[right])) {
    right += 1;
  }

  const leftCharacter = source[left - 1];
  const rightCharacter = source[right];
  const leftWhitespace = range.start - left;
  const rightWhitespace = right - range.end;

  const nextCharacter = source[right + 1];
  const mergesWithIncrement =
    isIdentifierCharacter(leftCharacter) &&
    (rightCharacter === "+" || rightCharacter === "-") &&
    nextCharacter === rightCharacter;

  let text = "";

  if (isOpeningDelimiter(leftCharacter) && isClosingDelimiter(rightCharacter)) {
    text = "";
  } else if (isOpeningDelimiter(leftCharacter) && leftWhitespace === 0) {
    text = "";
  } else if (isOpeningDelimiter(leftCharacter) && leftCharacter !== "{") {
    text = "";
  } else if (isClosingDelimiter(rightCharacter) && rightWhitespace === 0) {
    text = "";
  } else if (leftWhitespace > 0 && rightWhitespace > 0) {
    text = " ";
  } else if (mergesWithIncrement || needsSeparator(leftCharacter, rightCharacter)) {
    text = " ";
  }

  return { start: left, end: right, text };
}

export function applyRemovals(source: string, removals: RemovalRange[]): string {
  const edits = removals
    .map((range) => buildEdit(source, range))
    .sort((left, right) => right.start - left.start);

  let result = source;

  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }

  return result;
}

export function removeComments(
  source: string,
  options: SourceOptions = {},
): RemoveResult {
  const scan = scanSource(source, options);

  if (scan.errors.length > 0) {
    return {
      source,
      removed: 0,
      comments: scan.comments,
      errors: scan.errors,
    };
  }

  return {
    source: applyRemovals(source, scan.removals),
    removed: scan.comments.length,
    comments: scan.comments,
    errors: [],
  };
}
