# shh

> A radical no-comments linter for JavaScript and TypeScript.

[![npm](https://img.shields.io/npm/v/@yzlaboratory/shh.svg)](https://www.npmjs.com/package/@yzlaboratory/shh)
[![CI](https://github.com/yzlaboratory/shh/actions/workflows/ci.yml/badge.svg)](https://github.com/yzlaboratory/shh/actions/workflows/ci.yml)

`shh` is Prettier's angry little sibling. Instead of formatting your code, it finds comments and tells you to be quiet.

```console
$ shh check src

src/api/client.ts
  14:3   // retry twice because the backend is flaky
  51:1   /* legacy fallback */
  88:12  // TODO: clean this up

✖ Found 3 comments in 1 file.
```

## Why

Coding agents love comments. They explain obvious code, narrate temporary confusion, and leave behind TODO archaeology. Human readers then have to maintain prose that is coupled to implementation and goes stale silently.

`shh` takes the radical position for its first release: **comments are a lint error**. No exceptions. No exemptions. If you want a comment, rewrite the code until it does not need one.

This is intentionally blunt. A more nuanced policy can come later.

## Install

### Homebrew

```sh
brew install yzlaboratory/tap/shh
```

### npm

```sh
npm install --save-dev @yzlaboratory/shh
```

Requires Node.js 20 or newer.

Once installed, the binary is available locally:

```sh
npx shh check .
```

## Usage

```sh
shh [check] [files...] [options]
shh delete [files...] [options]
```

`check` is the default command.

### Find comments

```sh
shh check
shh check src
shh check "src/**/*.{ts,tsx}"
shh check --staged
```

`check` exits with code `1` when it finds comments, so it works directly as a CI or pre-commit gate. It never modifies files.

### Delete comments

```sh
shh delete . --dry-run
shh delete .
```

`delete` removes every comment it finds, along with the whitespace those comments leave behind. It refuses to write anything if any file fails to parse.

Always preview first:

```sh
shh delete . --dry-run
```

Then review the diff before committing:

```sh
shh delete .
git diff
```

### Options

| Option | Description |
| --- | --- |
| `--staged` | Use only files staged in git. Cannot be combined with file arguments. |
| `--ignore <glob>` | Ignore files matching a glob. Repeatable. |
| `--config <path>` | Use a specific config file. |
| `--no-gitignore` | Do not read `.gitignore`. |
| `--json` | Print machine-readable JSON. |
| `--quiet` | Suppress success output. Failures are still printed. |
| `--dry-run` | Preview `delete` without writing files. |
| `-h`, `--help` | Show help. |
| `-v`, `--version` | Show the version. |

### Supported files

`shh` parses these extensions by default:

```
.js  .jsx  .ts  .tsx  .mjs  .cjs  .mts  .cts
```

It understands JavaScript, TypeScript, JSX, and TSX syntax through Babel's parser, so comment-like text inside strings, template literals, and regular expressions is not treated as a comment.

Vue, Svelte, Astro, CSS, HTML, Markdown, Python, Go, Rust, and other languages are not supported yet.

## Configuration

Create `shh.config.json`:

```json
{
  "ignore": ["src/generated/**", "**/*.gen.ts"],
  "extensions": [".ts", ".tsx"]
}
```

Or add a `shh` key to `package.json`:

```json
{
  "shh": {
    "ignore": ["src/generated/**"]
  }
}
```

A `shh.config.json` file takes priority over the `package.json` key.

### Ignoring files

`shh` respects:

- `.gitignore` at the project root
- `.shhignore` at the project root
- `ignore` entries in `shh.config.json` or `package.json`
- `--ignore` flags

These directories are always ignored:

```
node_modules  .git  dist  build  coverage
.next  .nuxt  .svelte-kit  .turbo  vendor
```

## Pre-commit hooks

A pre-commit check is the whole point. Pick whichever setup you already use.

### lint-staged

```sh
npm install --save-dev @yzlaboratory/shh lint-staged
```

In `package.json`:

```json
{
  "lint-staged": {
    "*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}": "shh check"
  }
}
```

Then wire lint-staged into your hook using Husky or your existing setup. lint-staged passes the staged filenames to `shh check`, so you do not need `--staged` here.

### Husky

```sh
npm install --save-dev @yzlaboratory/shh husky
npx husky init
```

Create `.husky/pre-commit`:

```sh
npx --no-install shh check --staged
```

Make sure the hook is executable.

### Plain git hook

Create `.git/hooks/pre-commit`:

```sh
#!/bin/sh
exec npx --no-install shh check --staged
```

Then:

```sh
chmod +x .git/hooks/pre-commit
```

### Let the hook fix commits automatically

If you are feeling brave, make the hook delete comments and re-stage the result:

```sh
npx --no-install shh delete --staged
git add -u
```

This is deliberately aggressive. Most teams should start with `check` and run `delete` manually.

## Cleaning an existing repository

`check` is file-wide, not diff-wide. In a repository with existing comments, any commit that touches a commented file will fail until the comments are gone.

To clear them:

```sh
git switch -c remove-comments
shh delete . --dry-run
shh delete .
git diff
```

Review the result carefully before merging. The first release has no exemptions, so it will also remove:

- `// eslint-disable` and `// @ts-ignore` directives
- `/*#__PURE__*/` annotations
- license headers
- triple-slash TypeScript references
- code samples embedded in comments

That is the radical part. A later release can add a policy for comments that carry meaning to tooling.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No comments found, or deletion succeeded |
| `1` | Comments found by `check` |
| `2` | Invalid arguments, config errors, parse errors, or filesystem errors |

`delete --dry-run` exits with `0` even when it would remove comments, because it is a preview rather than a gate.

## JSON output

```sh
shh check --json
```

```json
{
  "version": 1,
  "command": "check",
  "ok": false,
  "files": [
    {
      "path": "src/a.ts",
      "comments": [
        {
          "kind": "line",
          "text": "// TODO",
          "line": 1,
          "column": 1,
          "endLine": 1,
          "endColumn": 8
        }
      ]
    }
  ],
  "errors": [],
  "summary": {
    "files": 1,
    "comments": 1
  }
}
```

## Programmatic API

```ts
import { removeComments, scanSource } from "@yzlaboratory/shh";

const scan = scanSource("const value = 1; // comment\n", {
  filename: "input.ts",
});

console.log(scan.comments.length);
console.log(scan.errors);

const result = removeComments("// comment\nconst value = 1;\n", {
  filename: "input.ts",
});

console.log(result.source);
console.log(result.removed);
```

## Releasing

Publishing is automated on pushes to `main`.

The repository has two guards:

- `.githooks/pre-push` checks npm before a push to `main` and fails if the current `package.json` version is already published.
- `.github/workflows/publish.yml` repeats that check, runs the test suite, and publishes with provenance.

`npm install` configures the hook path automatically.

Create the `@yzlaboratory` npm organization first if it does not exist.

The first version has to be published manually, because npm requires the package to exist before a trusted publisher can be configured:

```sh
npm publish --access public
```

Complete the 2FA prompt. Then connect the GitHub workflow:

```sh
npx npm@11.10.0 trust github @yzlaboratory/shh \
  --file publish.yml \
  --repo yzlaboratory/shh \
  -y
```

Enable the publish workflow:

```sh
gh workflow enable Publish --repo yzlaboratory/shh
```

After that, releases use OIDC trusted publishing. No `NPM_TOKEN` secret is needed.

Release with:

```sh
npm version patch
git push
```

Every push to `main` must have an unpublished version. For a non-release push, bump the version or bypass the local hook with `git push --no-verify`; the workflow will still fail if the version is already published.

## Development

```sh
npm install
npm run build
npm test
npm run check
```

`npm run check` runs `shh` against its own source. The codebase contains no comments. Obviously.

## License

MIT
