export const DEFAULT_EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
] as const;

export const DEFAULT_IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.svelte-kit/**",
  "**/.turbo/**",
  "**/vendor/**",
  "**/*.min.js",
  "**/*.min.mjs",
  "**/*.min.cjs",
] as const;

export const CONFIG_FILENAMES = ["shh.config.json"] as const;

export const IGNORE_FILENAMES = [".gitignore", ".shhignore"] as const;
