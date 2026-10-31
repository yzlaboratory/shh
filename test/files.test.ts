import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveFiles } from "../src/index.js";

function temporaryDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), "shh-files-"));
}

function write(cwd: string, filename: string, contents = ""): void {
  const target = path.join(cwd, filename);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

test("finds default source extensions", async () => {
  const cwd = temporaryDirectory();

  try {
    write(cwd, "src/a.ts");
    write(cwd, "src/b.jsx");
    write(cwd, "src/c.json", "{}");

    const files = await resolveFiles({ cwd });

    assert.deepEqual(
      files.map((filename) => path.relative(cwd, filename).split(path.sep).join("/")),
      ["src/a.ts", "src/b.jsx"],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("ignores dependency and build directories", async () => {
  const cwd = temporaryDirectory();

  try {
    write(cwd, "src/a.ts");
    write(cwd, "node_modules/pkg/index.js");
    write(cwd, "dist/index.js");
    write(cwd, "build/index.ts");

    const files = await resolveFiles({ cwd });

    assert.deepEqual(
      files.map((filename) => path.relative(cwd, filename).split(path.sep).join("/")),
      ["src/a.ts"],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("respects .gitignore and .shhignore", async () => {
  const cwd = temporaryDirectory();

  try {
    write(cwd, ".gitignore", "generated/\n");
    write(cwd, ".shhignore", "vendor-file.ts\n");
    write(cwd, "src/a.ts");
    write(cwd, "generated/a.ts");
    write(cwd, "vendor-file.ts");

    const files = await resolveFiles({ cwd });

    assert.deepEqual(
      files.map((filename) => path.relative(cwd, filename).split(path.sep).join("/")),
      ["src/a.ts"],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("supports custom ignore and extension settings", async () => {
  const cwd = temporaryDirectory();

  try {
    write(cwd, "src/a.ts");
    write(cwd, "src/b.tsx");

    const files = await resolveFiles({
      cwd,
      extensions: [".ts"],
      ignore: ["src/a.ts"],
    });

    assert.deepEqual(files, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("rejects unsupported explicit files", async () => {
  const cwd = temporaryDirectory();

  try {
    write(cwd, "notes.txt");

    await assert.rejects(
      resolveFiles({ cwd, patterns: ["notes.txt"] }),
      /Unsupported file type/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
