import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dryRun = process.argv.includes("--dry-run");
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const packageName = packageJson.name;
const version = packageJson.version;
const packageBasename = packageName.split("/").at(-1);
const tarballUrl = `https://registry.npmjs.org/${packageName}/-/${packageBasename}-${version}.tgz`;
const tapRepository =
  process.env.TAP_REPOSITORY ?? "yzlaboratory/homebrew-tap";
const formulaPath = process.env.TAP_FORMULA_PATH ?? "Formula/shh.rb";
const maxAttempts = 60;
const retryDelayMs = 5000;

async function downloadTarball() {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;

    try {
      response = await fetch(tarballUrl);
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(
          `Unable to download ${tarballUrl}: ${error.message}`,
        );
      }
    }

    if (response?.status === 404) {
      process.stdout.write(
        `Waiting for ${packageName}@${version} on npm (${attempt}/${maxAttempts})...\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      continue;
    }

    if (response && !response.ok) {
      throw new Error(
        `npm registry returned ${response.status} for ${tarballUrl}.`,
      );
    }

    if (response) {
      return Buffer.from(await response.arrayBuffer());
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  throw new Error(
    `Timed out waiting for ${packageName}@${version} on npm.`,
  );
}

const tarball = await downloadTarball();
const sha256 = createHash("sha256").update(tarball).digest("hex");
const directory = mkdtempSync(path.join(tmpdir(), "shh-homebrew-tap-"));

try {
  execFileSync(
    "git",
    [
      "clone",
      "--depth=1",
      `git@github.com:${tapRepository}.git`,
      directory,
    ],
    { stdio: "inherit" },
  );

  const formulaFile = path.join(directory, formulaPath);
  const current = readFileSync(formulaFile, "utf8");
  let next = current.replace(/^  url ".*"$/m, `  url "${tarballUrl}"`);
  next = next.replace(/^  sha256 ".*"$/m, `  sha256 "${sha256}"`);

  if (next === current) {
    process.stdout.write(
      `Homebrew formula already points at ${packageName}@${version}.\n`,
    );
  } else if (dryRun) {
    process.stdout.write(`${next}\n`);
  } else {
    writeFileSync(formulaFile, next);
    execFileSync(
      "git",
      ["config", "user.name", "github-actions[bot]"],
      { cwd: directory },
    );
    execFileSync(
      "git",
      [
        "config",
        "user.email",
        "41898282+github-actions[bot]@users.noreply.github.com",
      ],
      { cwd: directory },
    );
    execFileSync("git", ["add", formulaPath], { cwd: directory });
    execFileSync(
      "git",
      ["commit", "-m", `chore: bump shh to ${version}`],
      { cwd: directory, stdio: "inherit" },
    );
    execFileSync("git", ["push", "origin", "HEAD:main"], {
      cwd: directory,
      stdio: "inherit",
    });
    process.stdout.write(
      `Updated Homebrew formula to ${packageName}@${version}.\n`,
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
