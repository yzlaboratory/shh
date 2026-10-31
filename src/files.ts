import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import {
  DEFAULT_EXTENSIONS,
  DEFAULT_IGNORES,
  IGNORE_FILENAMES,
} from "./constants.js";

export interface ResolveFilesOptions {
  cwd: string;
  patterns?: string[];
  ignore?: string[];
  extensions?: string[];
  staged?: boolean;
  useGitignore?: boolean;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function normalizeExtensions(extensions: string[]): string[] {
  return [...new Set(extensions.map((extension) => {
    const trimmed = extension.trim().toLowerCase();
    return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  }))];
}

function extensionGlob(extensions: string[]): string {
  const names = extensions.map((extension) => extension.slice(1));

  if (names.length === 1) {
    return `*.${names[0]}`;
  }

  return `*.{${names.join(",")}}`;
}

function isSupportedFile(
  filename: string,
  extensions: string[],
): boolean {
  return extensions.includes(path.extname(filename).toLowerCase());
}

function relativePattern(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath);

  if (relative === "") {
    return ".";
  }

  if (relative.startsWith("..")) {
    return toPosix(absolutePath);
  }

  return toPosix(relative);
}

function addLiteralPattern(
  target: string[],
  arg: string,
  cwd: string,
  extensions: string[],
): void {
  const absolutePath = path.resolve(cwd, arg);

  if (existsSync(absolutePath)) {
    if (statSync(absolutePath).isDirectory()) {
      target.push(
        `${fg.escapePath(relativePattern(cwd, absolutePath))}/**/${extensionGlob(extensions)}`,
      );
      return;
    }

    if (!isSupportedFile(absolutePath, extensions)) {
      throw new Error(`Unsupported file type: ${arg}`);
    }

    target.push(fg.escapePath(relativePattern(cwd, absolutePath)));
    return;
  }

  if (fg.isDynamicPattern(arg)) {
    target.push(toPosix(arg));
    return;
  }

  throw new Error(`No such file or directory: ${arg}`);
}

function buildPatterns(
  args: string[],
  cwd: string,
  extensions: string[],
): string[] {
  if (args.length === 0) {
    return [`**/${extensionGlob(extensions)}`];
  }

  const patterns: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("!")) {
      patterns.push(`!${toPosix(arg.slice(1))}`);
      continue;
    }

    addLiteralPattern(patterns, arg, cwd, extensions);
  }

  return patterns;
}

function loadIgnoreMatcher(cwd: string, useGitignore: boolean) {
  const matcher = ignore();

  for (const filename of IGNORE_FILENAMES) {
    if (filename === ".gitignore" && !useGitignore) {
      continue;
    }

    const ignorePath = path.join(cwd, filename);

    if (existsSync(ignorePath)) {
      matcher.add(readFileSync(ignorePath, "utf8"));
    }
  }

  return matcher;
}

function isIgnored(
  matcher: ReturnType<typeof ignore>,
  cwd: string,
  absolutePath: string,
): boolean {
  const relative = toPosix(path.relative(cwd, absolutePath));

  if (relative === "" || relative === ".." || relative.startsWith("../")) {
    return false;
  }

  return matcher.ignores(relative);
}

function stagedPaths(cwd: string): string[] {
  try {
    const output = execFileSync(
      "git",
      [
        "diff",
        "--cached",
        "--name-only",
        "--diff-filter=ACMR",
        "-z",
        "--relative",
      ],
      { cwd, encoding: "utf8" },
    );

    return output.split("\0").filter(Boolean);
  } catch {
    throw new Error("Unable to read staged files. Is this a git repository?");
  }
}

async function collect(
  patterns: string[],
  cwd: string,
  ignores: string[],
): Promise<string[]> {
  if (patterns.length === 0) {
    return [];
  }

  return fg(patterns, {
    cwd,
    absolute: true,
    onlyFiles: true,
    unique: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: ignores,
  });
}

export async function resolveFiles(
  options: ResolveFilesOptions,
): Promise<string[]> {
  const cwd = options.cwd;
  const extensions = normalizeExtensions(
    options.extensions ?? [...DEFAULT_EXTENSIONS],
  );
  const patterns = options.patterns ?? [];
  const ignorePatterns = [
    ...DEFAULT_IGNORES,
    ...(options.ignore ?? []),
  ];
  const useGitignore = options.useGitignore ?? true;
  const matcher = loadIgnoreMatcher(cwd, useGitignore);

  if (options.staged) {
    if (patterns.length > 0) {
      throw new Error("File arguments cannot be combined with --staged.");
    }

    const staged = stagedPaths(cwd)
      .map((filename) => path.resolve(cwd, filename))
      .filter((filename) => existsSync(filename))
      .filter((filename) => isSupportedFile(filename, extensions))
      .filter((filename) => !isIgnored(matcher, cwd, filename));

    if (staged.length === 0) {
      return [];
    }

    const files = await collect(
      staged.map((filename) => fg.escapePath(relativePattern(cwd, filename))),
      cwd,
      ignorePatterns,
    );

    return files.filter((filename) => !isIgnored(matcher, cwd, filename)).sort();
  }

  const globs = buildPatterns(patterns, cwd, extensions);
  const files = await collect(globs, cwd, ignorePatterns);

  return files
    .filter((filename) => isSupportedFile(filename, extensions))
    .filter((filename) => !isIgnored(matcher, cwd, filename))
    .sort();
}
