import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(repositoryRoot, "dist", "cli.js");

function temporaryDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), "shh-test-"));
}

function runCli(
  cwd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function write(cwd: string, filename: string, contents: string): void {
  const target = path.join(cwd, filename);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

test("checks files and exits with code 1 when comments are found", () => {
  const cwd = temporaryDirectory();

  try {
    write(cwd, "src/a.ts", "// one\nconst value = 1; // two\n");
    write(cwd, "src/b.ts", "const clean = true;\n");

    const result = runCli(cwd, ["check", "src"]);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /src\/a\.ts/);
    assert.match(result.stdout, /1:1\s+\/\/ one/);
    assert.match(result.stdout, /Found 2 comments in 1 file/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checks clean files and exits with code 0", () => {
  const cwd = temporaryDirectory();

  try {
    write(cwd, "src/a.ts", "const value = 1;\n");

    const result = runCli(cwd, ["check", "src"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /No comments found in 1 file/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("previews deletions with --dry-run", () => {
  const cwd = temporaryDirectory();
  const source = "// comment\nconst value = 1;\n";

  try {
    write(cwd, "a.ts", source);

    const result = runCli(cwd, ["delete", "a.ts", "--dry-run"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Would remove 1 comment/);
    assert.equal(readFileSync(path.join(cwd, "a.ts"), "utf8"), source);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("deletes comments and leaves clean code behind", () => {
  const cwd = temporaryDirectory();

  try {
    write(cwd, "a.ts", "// comment\nconst value = 1; // trailing\n");
    write(cwd, "b.tsx", "const view = <div>{/* jsx */}</div>;\n");

    const result = runCli(cwd, ["delete", "."]);

    assert.equal(result.status, 0);
    assert.equal(
      readFileSync(path.join(cwd, "a.ts"), "utf8"),
      "const value = 1;\n",
    );
    assert.equal(
      readFileSync(path.join(cwd, "b.tsx"), "utf8"),
      "const view = <div></div>;\n",
    );

    const check = runCli(cwd, ["check", "."]);
    assert.equal(check.status, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("prints JSON for editor and CI integrations", () => {
  const cwd = temporaryDirectory();

  try {
    write(cwd, "a.ts", "// comment\nconst value = 1;\n");

    const result = runCli(cwd, ["check", "a.ts", "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      files: Array<{ path: string; comments: unknown[] }>;
      summary: { comments: number };
    };

    assert.equal(result.status, 1);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.summary.comments, 1);
    assert.equal(parsed.files[0]?.path, "a.ts");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("respects shh.config.json and package.json configuration", () => {
  const cwd = temporaryDirectory();

  try {
    write(cwd, "shh.config.json", '{"ignore":["src/generated/**"]}\n');
    write(cwd, "src/generated/a.ts", "// generated\n");
    write(cwd, "src/b.ts", "// source\n");

    const result = runCli(cwd, ["check", "."]);

    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /generated/);
    assert.match(result.stdout, /src\/b\.ts/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checks only staged files with --staged", () => {
  const cwd = temporaryDirectory();

  try {
    execFileSync("git", ["init", "-q"], { cwd });
    write(cwd, "staged.ts", "// staged\nconst value = 1;\n");
    write(cwd, "unstaged.ts", "// unstaged\nconst value = 2;\n");
    execFileSync("git", ["add", "staged.ts"], { cwd });

    const result = runCli(cwd, ["check", "--staged"]);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /staged\.ts/);
    assert.doesNotMatch(result.stdout, /unstaged\.ts/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
