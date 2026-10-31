#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { loadConfig } from "./config.js";
import {
  applyRemovals,
  scanSource,
  type ScanResult,
  type SourceComment,
} from "./comments.js";
import { resolveFiles } from "./files.js";

type Command = "check" | "delete";

interface CliOptions {
  command: Command;
  patterns: string[];
  ignore: string[];
  staged: boolean;
  json: boolean;
  quiet: boolean;
  dryRun: boolean;
  useGitignore: boolean;
  configPath?: string;
  help: boolean;
  version: boolean;
}

interface ScannedFile {
  path: string;
  source: string;
  scan: ScanResult;
}

interface ReportedError {
  path: string;
  message: string;
  line?: number;
  column?: number;
}

const HELP = `shh

Usage:
  shh [check] [files...] [options]
  shh delete [files...] [options]

Commands:
  check    Find comments and exit 1 when any are found (default)
  delete   Remove comments from source files

Options:
  --staged          Use files staged in git
  --ignore <glob>   Ignore files matching a glob (repeatable)
  --config <path>   Path to a shh config file
  --no-gitignore    Do not read .gitignore
  --json            Print machine-readable JSON
  --quiet           Suppress success output
  --dry-run         Preview delete without writing files
  -h, --help        Show help
  -v, --version     Show version

Files:
  JavaScript, TypeScript, JSX, and TSX are supported.
  .gitignore and .shhignore are respected automatically.

Examples:
  shh check
  shh check src
  shh check --staged
  shh delete src --dry-run
  shh delete src

Config:
  Add shh.config.json or a "shh" key in package.json:
  { "ignore": ["src/generated/**"], "extensions": [".ts", ".tsx"] }
`;

function readVersion(): string {
  const packagePath = new URL("../package.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
    version?: string;
  };

  return parsed.version ?? "0.0.0";
}

function takeValue(
  argv: string[],
  index: number,
  option: string,
): { value: string; index: number } {
  const value = argv[index + 1];

  if (!value) {
    throw new Error(`Missing value for ${option}.`);
  }

  return { value, index: index + 1 };
}

export function parseArgs(argv: string[]): CliOptions {
  let index = 0;
  let command: Command = "check";

  if (argv[0] === "check" || argv[0] === "delete") {
    command = argv[0];
    index = 1;
  }

  const options: CliOptions = {
    command,
    patterns: [],
    ignore: [],
    staged: false,
    json: false,
    quiet: false,
    dryRun: false,
    useGitignore: true,
    help: false,
    version: false,
  };

  let literalArguments = false;

  for (; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === undefined) {
      continue;
    }

    if (literalArguments) {
      options.patterns.push(argument);
      continue;
    }

    if (argument === "--") {
      literalArguments = true;
      continue;
    }

    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }

    if (argument === "-v" || argument === "--version") {
      options.version = true;
      continue;
    }

    if (argument === "--staged") {
      options.staged = true;
      continue;
    }

    if (argument === "--json") {
      options.json = true;
      continue;
    }

    if (argument === "--quiet") {
      options.quiet = true;
      continue;
    }

    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (argument === "--no-gitignore") {
      options.useGitignore = false;
      continue;
    }

    if (argument === "--ignore") {
      const taken = takeValue(argv, index, "--ignore");
      options.ignore.push(taken.value);
      index = taken.index;
      continue;
    }

    if (argument.startsWith("--ignore=")) {
      options.ignore.push(argument.slice("--ignore=".length));
      continue;
    }

    if (argument === "--config") {
      const taken = takeValue(argv, index, "--config");
      options.configPath = taken.value;
      index = taken.index;
      continue;
    }

    if (argument.startsWith("--config=")) {
      options.configPath = argument.slice("--config=".length);
      continue;
    }

    if (argument.startsWith("-") && argument !== "-") {
      throw new Error(`Unknown option: ${argument}`);
    }

    options.patterns.push(argument);
  }

  if (command === "check" && options.dryRun) {
    throw new Error("--dry-run can only be used with the delete command.");
  }

  return options;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function displayPath(cwd: string, filename: string): string {
  const relative = path.relative(cwd, filename);

  if (relative === "") {
    return ".";
  }

  if (relative.startsWith("..")) {
    return toPosix(filename);
  }

  return toPosix(relative);
}

function cleanMessage(message: string): string {
  return message.replace(/\s*\(\d+:\d+\)\s*$/, "").trim();
}

function snippet(comment: SourceComment): string {
  const collapsed = comment.text.replace(/\s+/g, " ").trim();
  const limit = 100;

  if (collapsed.length <= limit) {
    return collapsed;
  }

  return `${collapsed.slice(0, limit - 1)}…`;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await mapper(items[current] as T);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );

  return results;
}

async function scanFiles(cwd: string, files: string[]): Promise<ScannedFile[]> {
  return mapLimit(files, 8, async (filename) => {
    let source: string;

    try {
      source = await readFile(filename, "utf8");
    } catch (error) {
      throw new Error(
        `Unable to read ${displayPath(cwd, filename)}: ${(error as Error).message}`,
      );
    }

    return {
      path: filename,
      source,
      scan: scanSource(source, { filename }),
    };
  });
}

function collectErrors(cwd: string, scans: ScannedFile[]): ReportedError[] {
  return scans.flatMap((file) =>
    file.scan.errors.map((error) => ({
      path: displayPath(cwd, file.path),
      message: cleanMessage(error.message),
      line: error.line,
      column: error.column,
    })),
  );
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

function printErrors(errors: ReportedError[]): void {
  for (const error of errors) {
    const location =
      error.line !== undefined
        ? `:${error.line}${error.column !== undefined ? `:${error.column}` : ""}`
        : "";

    process.stderr.write(
      `${pc.red("error")} ${error.path}${location} ${error.message}\n`,
    );
  }
}

function printCheckReport(cwd: string, scans: ScannedFile[]): void {
  for (const file of scans) {
    if (file.scan.comments.length === 0) {
      continue;
    }

    process.stdout.write(`${pc.bold(displayPath(cwd, file.path))}\n`);

    for (const comment of file.scan.comments) {
      const location = `${comment.line}:${comment.column + 1}`;
      process.stdout.write(
        `  ${pc.dim(location)}  ${pc.yellow(snippet(comment))}\n`,
      );
    }
  }
}

function printCheckJson(cwd: string, scans: ScannedFile[]): void {
  const errors = collectErrors(cwd, scans);
  const files = scans
    .filter((file) => file.scan.comments.length > 0)
    .map((file) => ({
      path: displayPath(cwd, file.path),
      comments: file.scan.comments.map((comment) => ({
        kind: comment.kind,
        text: snippet(comment),
        line: comment.line,
        column: comment.column + 1,
        endLine: comment.endLine,
        endColumn: comment.endColumn + 1,
      })),
    }));
  const commentCount = files.reduce(
    (total, file) => total + file.comments.length,
    0,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        version: 1,
        command: "check",
        ok: commentCount === 0 && errors.length === 0,
        files,
        errors,
        summary: {
          files: scans.length,
          comments: commentCount,
        },
      },
      null,
      2,
    )}\n`,
  );
}

function printDeleteReport(
  cwd: string,
  changes: Array<{ path: string; removed: number }>,
  dryRun: boolean,
  scannedFileCount: number,
): void {
  if (changes.length === 0) {
    process.stdout.write(
      `${pc.green("✔")} No comments found in ${scannedFileCount} ${plural(scannedFileCount, "file", "files")}.\n`,
    );
    return;
  }

  for (const change of changes) {
    process.stdout.write(
      `${pc.bold(displayPath(cwd, change.path))}  ${change.removed} ${plural(change.removed, "comment", "comments")} ${dryRun ? "would be removed" : "removed"}\n`,
    );
  }

  const total = changes.reduce((sum, change) => sum + change.removed, 0);
  const action = dryRun ? "Would remove" : "Removed";

  process.stdout.write(
    `\n${pc.green("✔")} ${action} ${total} ${plural(total, "comment", "comments")} from ${changes.length} ${plural(changes.length, "file", "files")}.\n`,
  );
}

async function deleteComments(
  cwd: string,
  scans: ScannedFile[],
  options: CliOptions,
): Promise<number> {
  const errors = collectErrors(cwd, scans);

  if (errors.length > 0) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            version: 1,
            command: "delete",
            ok: false,
            changed: [],
            errors,
            summary: { files: scans.length, comments: 0 },
          },
          null,
          2,
        )}\n`,
      );
    } else {
      printErrors(errors);
      process.stderr.write(
        `${pc.red("✖")} No files were changed because some files could not be parsed.\n`,
      );
    }

    return 2;
  }

  const changes: Array<{
    path: string;
    source: string;
    removed: number;
  }> = [];

  for (const file of scans) {
    if (file.scan.comments.length === 0) {
      continue;
    }

    const stripped = applyRemovals(file.source, file.scan.removals);

    if (stripped !== file.source) {
      changes.push({
        path: file.path,
        source: stripped,
        removed: file.scan.comments.length,
      });
    }
  }

  if (!options.dryRun) {
    await Promise.all(
      changes.map((change) => writeFile(change.path, change.source, "utf8")),
    );
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          version: 1,
          command: "delete",
          ok: true,
          dryRun: options.dryRun,
          changed: changes.map((change) => ({
            path: displayPath(cwd, change.path),
            removed: change.removed,
          })),
          errors: [],
          summary: {
            files: scans.length,
            comments: changes.reduce(
              (total, change) => total + change.removed,
              0,
            ),
          },
        },
        null,
        2,
      )}\n`,
    );
  } else if (!options.quiet) {
    printDeleteReport(
      cwd,
      changes.map((change) => ({
        path: change.path,
        removed: change.removed,
      })),
      options.dryRun,
      scans.length,
    );
  }

  return 0;
}

function noFilesMatched(options: CliOptions): boolean {
  return options.patterns.length > 0 && !options.staged;
}

export async function run(argv: string[]): Promise<number> {
  try {
    if (argv[0] === "help") {
      process.stdout.write(HELP);
      return 0;
    }

    const options = parseArgs(argv);

    if (options.help) {
      process.stdout.write(HELP);
      return 0;
    }

    if (options.version) {
      process.stdout.write(`${readVersion()}\n`);
      return 0;
    }

    const cwd = process.cwd();
    const config = loadConfig(cwd, options.configPath);
    const files = await resolveFiles({
      cwd,
      patterns: options.patterns,
      ignore: [...config.ignore, ...options.ignore],
      extensions:
        config.extensions.length > 0 ? config.extensions : undefined,
      staged: options.staged,
      useGitignore: options.useGitignore,
    });

    if (files.length === 0 && noFilesMatched(options)) {
      process.stderr.write(
        `${pc.red("error")} No files matched the provided patterns.\n`,
      );
      return 2;
    }

    const scans = await scanFiles(cwd, files);

    if (options.command === "delete") {
      return deleteComments(cwd, scans, options);
    }

    const errors = collectErrors(cwd, scans);
    const commentCount = scans.reduce(
      (total, file) => total + file.scan.comments.length,
      0,
    );

    if (options.json) {
      printCheckJson(cwd, scans);
    } else if (!options.quiet || commentCount > 0 || errors.length > 0) {
      printCheckReport(cwd, scans);
      printErrors(errors);

      if (commentCount > 0) {
        const fileCount = scans.filter(
          (file) => file.scan.comments.length > 0,
        ).length;

        process.stdout.write(
          `\n${pc.red("✖")} Found ${commentCount} ${plural(commentCount, "comment", "comments")} in ${fileCount} ${plural(fileCount, "file", "files")}.\n`,
        );
      } else if (errors.length === 0) {
        process.stdout.write(
          `${pc.green("✔")} No comments found in ${scans.length} ${plural(scans.length, "file", "files")}.\n`,
        );
      }

      if (errors.length > 0) {
        process.stderr.write(
          `${pc.red("✖")} ${errors.length} ${plural(errors.length, "file", "files")} could not be parsed.\n`,
        );
      }
    }

    if (errors.length > 0) {
      return 2;
    }

    return commentCount > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(
      `${pc.red("error")} ${(error as Error).message}\n`,
    );
    return 2;
  }
}

function isEntryPoint(): boolean {
  const entryPoint = process.argv[1];

  if (!entryPoint) {
    return false;
  }

  try {
    return realpathSync(entryPoint) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
