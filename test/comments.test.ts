import assert from "node:assert/strict";
import test from "node:test";
import {
  removeComments,
  scanSource,
} from "../src/index.js";

function strip(source: string, filename = "input.ts"): string {
  return removeComments(source, { filename }).source;
}

test("finds line and block comments", () => {
  const source = [
    "const first = 1; // line",
    "const second = /* block */ 2;",
    "",
  ].join("\n");

  const scan = scanSource(source, { filename: "input.ts" });

  assert.equal(scan.errors.length, 0);
  assert.equal(scan.comments.length, 2);
  assert.deepEqual(
    scan.comments.map((comment) => ({
      kind: comment.kind,
      line: comment.line,
      column: comment.column,
    })),
    [
      { kind: "line", line: 1, column: 17 },
      { kind: "block", line: 2, column: 15 },
    ],
  );
});

test("ignores comment-like text in strings, templates, and regexes", () => {
  const source = [
    'const url = "https://example.com//path";',
    "const regex = /\\/\\//;",
    "const template = `/* not a comment */`;",
    "// real comment",
    "",
  ].join("\n");

  const scan = scanSource(source, { filename: "input.ts" });

  assert.equal(scan.comments.length, 1);
  assert.equal(scan.comments[0]?.text, "// real comment");
});

test("does not treat a shebang as a comment", () => {
  const source = "#!/usr/bin/env node\n// comment\nconst value = 1;\n";

  assert.equal(strip(source), "#!/usr/bin/env node\nconst value = 1;\n");
});

test("removes full comment lines", () => {
  assert.equal(
    strip("// first\n// second\nconst value = 1;\n"),
    "const value = 1;\n",
  );
});

test("removes trailing comments without leaving whitespace", () => {
  assert.equal(
    strip("const value = 1; // comment\nconst other = 2;\n"),
    "const value = 1;\nconst other = 2;\n",
  );
});

test("removes inline block comments and preserves token separation", () => {
  assert.equal(
    strip("const value = 1 /* comment */ + 2;\n"),
    "const value = 1 + 2;\n",
  );
  assert.equal(strip("return/* comment */value;\n"), "return value;\n");
  assert.equal(strip("let/* comment */value = 1;\n"), "let value = 1;\n");
});

test("removes comments at the start of a line without removing indentation", () => {
  assert.equal(
    strip("function run() {\n  /* comment */ return 1;\n}\n"),
    "function run() {\n  return 1;\n}\n",
  );
});

test("removes multi-line block comments", () => {
  assert.equal(
    strip("const value = 1; /* start\nmiddle\nend */\nconst other = 2;\n"),
    "const value = 1;\nconst other = 2;\n",
  );
  assert.equal(
    strip("/* start\nmiddle\nend */\nconst value = 1;\n"),
    "const value = 1;\n",
  );
});

test("removes adjacent comments on the same line", () => {
  assert.equal(
    strip("const value = 1; /* one */ /* two */\n"),
    "const value = 1;\n",
  );
});

test("removes JSX comments and empty expression containers", () => {
  const source = [
    "const view = (",
    "  <div>",
    "    {/* a JSX comment */}",
    "    <span>Hello {/* inline */} world</span>",
    "  </div>",
    ");",
    "",
  ].join("\n");

  assert.equal(
    strip(source, "input.tsx"),
    [
      "const view = (",
      "  <div>",
      "    <span>Hello world</span>",
      "  </div>",
      ");",
      "",
    ].join("\n"),
  );
});

test("preserves a UTF-8 byte order mark", () => {
  assert.equal(
    strip("\uFEFF// comment\nconst value = 1;\n"),
    "\uFEFFconst value = 1;\n",
  );
});

test("preserves CRLF line endings", () => {
  assert.equal(
    strip("const value = 1; // comment\r\nconst other = 2;\r\n"),
    "const value = 1;\r\nconst other = 2;\r\n",
  );
});

test("reports parse errors without changing source", () => {
  const source = "const value = ;\n// comment\n";
  const result = removeComments(source, { filename: "input.ts" });

  assert.equal(result.source, source);
  assert.equal(result.removed, 0);
  assert.ok(result.errors.length > 0);
});

test("keeps a trailing newline at end of file", () => {
  assert.equal(strip("const value = 1; // comment"), "const value = 1;");
  assert.equal(strip("// comment\n"), "");
});
