import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILENAMES } from "./constants.js";

export interface ShhConfig {
  ignore: string[];
  extensions: string[];
}

interface RawConfig {
  ignore?: unknown;
  extensions?: unknown;
}

function stringArray(value: unknown, key: string, filename: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`"${key}" in ${filename} must be an array of strings.`);
  }

  return value;
}

function normalizeConfig(raw: RawConfig, filename: string): ShhConfig {
  return {
    ignore: stringArray(raw.ignore, "ignore", filename),
    extensions: stringArray(raw.extensions, "extensions", filename).map(
      (extension) => {
        const trimmed = extension.trim().toLowerCase();
        return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
      },
    ),
  };
}

function readJson(filename: string): unknown {
  try {
    return JSON.parse(readFileSync(filename, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to read ${filename}: ${(error as Error).message}`,
    );
  }
}

function readConfigFile(filename: string): ShhConfig {
  const parsed = readJson(filename);

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Configuration in ${filename} must be an object.`);
  }

  return normalizeConfig(parsed as RawConfig, filename);
}

function readPackageConfig(filename: string): ShhConfig | undefined {
  const parsed = readJson(filename);

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const raw = (parsed as { shh?: unknown }).shh;

  if (raw === undefined) {
    return undefined;
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`"shh" in ${filename} must be an object.`);
  }

  return normalizeConfig(raw as RawConfig, filename);
}

export function loadConfig(
  cwd: string,
  explicitConfigPath?: string,
): ShhConfig {
  if (explicitConfigPath) {
    const filename = path.resolve(cwd, explicitConfigPath);

    if (!existsSync(filename)) {
      throw new Error(`Configuration file not found: ${explicitConfigPath}`);
    }

    return readConfigFile(filename);
  }

  for (const configFilename of CONFIG_FILENAMES) {
    const filename = path.join(cwd, configFilename);

    if (existsSync(filename)) {
      return readConfigFile(filename);
    }
  }

  const packageFilename = path.join(cwd, "package.json");

  if (existsSync(packageFilename)) {
    const packageConfig = readPackageConfig(packageFilename);

    if (packageConfig) {
      return packageConfig;
    }
  }

  return { ignore: [], extensions: [] };
}
