import { execFileSync } from "node:child_process";

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    ...options,
  }).trim();
}

try {
  git(["rev-parse", "--show-toplevel"]);

  let existing = "";

  try {
    existing = git(["config", "--local", "--get", "core.hooksPath"]);
  } catch {
    existing = "";
  }

  if (existing === ".githooks") {
    process.exit(0);
  }

  if (existing) {
    process.stderr.write(
      `Not changing core.hooksPath because it is already set to "${existing}".\n`,
    );
    process.exit(0);
  }

  git(["config", "--local", "core.hooksPath", ".githooks"]);
  process.stdout.write("Configured git hooks path: .githooks\n");
} catch {
  process.stderr.write("Skipped git hook installation.\n");
}
