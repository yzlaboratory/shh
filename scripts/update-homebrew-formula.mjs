import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const GIT =
  [
    "/usr/bin/git",
    "/usr/local/bin/git",
    "/opt/homebrew/bin/git",
    "C:\\Program Files\\Git\\cmd\\git.exe",
  ].find((candidate) => existsSync(candidate)) ?? "git";
const NPM = (() => {
  const candidate = path.join(
    path.dirname(process.execPath),
    process.platform === "win32" ? "npm.cmd" : "npm",
  );
  return existsSync(candidate) ? candidate : "npm";
})();

const dryRun = process.argv.includes("--dry-run");
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const packageName = packageJson.name;
const version = packageJson.version;
const repository = process.env.GITHUB_REPOSITORY ?? "yzlaboratory/shh";
const releaseTag = process.env.RELEASE_TAG ?? `v${version}`;
const assetName =
  process.env.RELEASE_ASSET_NAME ??
  `${packageName.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
const tarballUrl =
  process.env.HOMEBREW_TARBALL_URL ??
  `https://github.com/${repository}/releases/download/${releaseTag}/${assetName}`;
const tapRepository =
  process.env.TAP_REPOSITORY ?? "yzlaboratory/homebrew-tap";
const formulaPath = process.env.TAP_FORMULA_PATH ?? "Formula/shh.rb";

function tarballSha256() {
  const configured = process.env.HOMEBREW_TARBALL_PATH;

  if (configured) {
    return createHash("sha256").update(readFileSync(configured)).digest("hex");
  }

  const directory = mkdtempSync(path.join(tmpdir(), "shh-pack-"));

  try {
    const output = execFileSync(
      NPM,
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        directory,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    const parsed = JSON.parse(output);
    const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    const tarball = readFileSync(path.join(directory, packed.filename));
    return createHash("sha256").update(tarball).digest("hex");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const sha256 = process.env.HOMEBREW_SHA256 ?? tarballSha256();

if (!/^[a-f0-9]{64}$/i.test(sha256)) {
  throw new Error(`Invalid SHA-256 checksum: ${sha256}`);
}

const directory = mkdtempSync(path.join(tmpdir(), "shh-homebrew-tap-"));

try {
  execFileSync(
    GIT,
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

  if (
    !/^  url ".*"$/m.test(current) ||
    !/^  sha256 ".*"$/m.test(current)
  ) {
    throw new Error(`Unable to find url and sha256 in ${formulaPath}.`);
  }

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
      GIT,
      ["config", "user.name", "github-actions[bot]"],
      { cwd: directory },
    );
    execFileSync(
      GIT,
      [
        "config",
        "user.email",
        "41898282+github-actions[bot]@users.noreply.github.com",
      ],
      { cwd: directory },
    );
    execFileSync(GIT, ["add", formulaPath], { cwd: directory });
    execFileSync(
      GIT,
      ["commit", "-m", `chore: bump shh to ${version}`],
      { cwd: directory, stdio: "inherit" },
    );
    execFileSync(GIT, ["push", "origin", "HEAD:main"], {
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
