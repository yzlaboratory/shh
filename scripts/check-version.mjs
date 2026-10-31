import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const packageName = process.argv[2] ?? packageJson.name;
const version = process.argv[3] ?? packageJson.version;
const registryUrl = `https://registry.npmjs.org/${packageName.replace("/", "%2f")}`;

async function main() {
  let response;

  try {
    response = await fetch(registryUrl, {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new Error(
      `Unable to reach the npm registry for ${packageName}: ${error.message}`,
    );
  }

  if (response.status === 404) {
    process.stdout.write(`${packageName}@${version} is not published.\n`);
    return;
  }

  if (!response.ok) {
    throw new Error(
      `npm registry returned ${response.status} for ${packageName}.`,
    );
  }

  const metadata = await response.json();
  const versions = metadata.versions ?? {};

  if (Object.hasOwn(versions, version)) {
    process.stderr.write(
      `${packageName}@${version} is already published. Bump the version before pushing.\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${packageName}@${version} is not published.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
