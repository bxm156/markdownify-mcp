# CLAUDE.md

Guidance for agents working in this repository. Subdirectories have their own notes:
see src/CLAUDE.md, src/remote/CLAUDE.md, scripts/CLAUDE.md, examples/CLAUDE.md,
docs/CLAUDE.md and .github/workflows/CLAUDE.md. How to run every kind of test: TESTING.md.

## What this repo is

One npm package (`mcp-markdownify-server`), two separate servers:

- **Local stdio MCP server**: `src/*.ts` -> `dist/index.js`. Fork of upstream
  `zcaceres/markdownify-mcp`; 11 tools (local paths, URLs, git repos). Runs on macOS, Linux and Windows.
- **Remote HTTP MCP service**: `src/remote/` -> `dist/remote/index.js`. Streamable HTTP at `/mcp`,
  authenticated uploads, async per-agent jobs, quotas, audit, `/livez` `/readyz`. Linux only, shipped as
  the container image built from `Dockerfile.remote` (Docker Hub `bryanmarty/markdownify-mcp`).

Both convert with Microsoft MarkItDown (Python, pure-Python parsers: pdfminer.six, mammoth, openpyxl,
python-pptx), run as a subprocess. `resolveMarkitdownPath` (`src/utils.ts`, shared by both servers) picks
`MARKITDOWN_PATH`, then `.venv/bin/markitdown` (`.venv/Scripts/markitdown.exe` on Windows), then `markitdown` on PATH.

## Toolchain

- **Bun 1.4.2** for install, build, test and scripts. Never npm, pnpm or yarn; do not add other lockfiles.
- **Node 22** is the production runtime of the remote server (`engines.node >= 22`, `@types/node ^22`,
  image `node:22`). Some tests and smokes spawn `node` from PATH, so have Node 22 installed.
- **Python 3.12 + markitdown 0.1.5** in `.venv` (`.python-version`, CI and the images all say 3.12; `pyproject.toml` pins the converter).
  Create it with `uv sync` (pyproject.toml + uv.lock) or `./setup.sh` (`setup.bat` on Windows); details in TESTING.md.
- **TypeScript** strict, ESM (`"type": "module"`), `module`/`moduleResolution` Node16: relative imports
  need the `.js` suffix. `tsconfig.json` builds `src/` only; `tsconfig.check.json` also type-checks tests,
  `scripts/` and `examples/` (bundler resolution, Bun types).
- Code under `src/` (excluding tests) must run under both Bun and Node: no `Bun.*` or `bun:*` outside
  `*.test.ts` and `src/remote/test-helpers.ts`.

## Commands

```sh
bun install --frozen-lockfile --ignore-scripts   # --ignore-scripts: skip the preinstall hook (setup.sh rewrites .venv)
bun run typecheck                                # tsc --noEmit -p tsconfig.check.json (src, tests, scripts, examples)
bun run build                                    # stdio + remote -> dist/ (tsc, chmod +x dist/*.js)
bun run build:remote                             # same tsc build, no chmod; used by CI and Dockerfile.remote
bun test                                         # everything: stdio, remote, scripts/*.test.ts (~35-40 s)
bun test src/remote                              # remote suite only (= bun run test:remote, ~17 s)
bun test src/remote/jobs.test.ts -t "<regex>"    # one file / matching tests
bun start                                        # stdio server (bun dist/index.js)
bun run start:remote                             # remote server (node dist/remote/index.js; needs MD_* env, see docs/REMOTE.md)
```

Docs site (own venv outside the repo; `.venv` is the converter's and only `.venv` is gitignored):

```sh
python3 -m venv /tmp/mkdocs-venv && /tmp/mkdocs-venv/bin/pip install -r docs/requirements.txt
/tmp/mkdocs-venv/bin/python mkdocs_hooks.py                           # link-hook self-check
NO_MKDOCS_2_WARNING=true /tmp/mkdocs-venv/bin/mkdocs build --strict -d /tmp/site-check
```

## Conventions and gotchas

- **LF line endings everywhere** (`.gitattributes`: `* text=auto eol=lf`). The only exception is `*.bat`
  (`setup.bat`), checked out with CRLF for cmd.exe. Never commit CRLF.
- **Tests** use `bun:test` and sit next to the code as `*.test.ts`. `tsconfig.json` excludes `src/**/*.test.ts`
  and `src/**/test-helpers.ts` from the build; production code and scripts never import `test-helpers.ts`.
- **No fixed sleeps** in tests: wait with `waitFor` (`src/remote/test-helpers.ts`) or move the clock with
  `setSystemTime`. Assert error codes (`error_info.code` via `toolErrorCode`, `ServiceError.code`), not a bare
  `isError` or message text.
- **Root**: the Claude cloud container runs as root, so chmod-based permission denials do not happen. Guard such
  tests with `test.skipIf(process.getuid?.() === 0)` (see `src/remote/cleanup.test.ts`).
- **Skips**: stdio tests that need the real converter skip when markitdown is not found; git-clone tests run only
  with `MD_TEST_NETWORK=1`; POSIX-only tests skip on win32. Do not "fix" a failure by adding a skip.
- **Python scripts** (`scripts/*.py`) must work under `python -O`: no bare `assert` (a CI grep rejects
  `^\s*assert `); use an explicit `raise` or a `check()` helper.
- **Errors**: every client-visible remote failure has a code in the `catalog` of `src/remote/errors.ts`
  (`{ message, retryable, next_steps }`, one entry per line). Keep that style and update `docs/ERRORS.md` with it.
- **Logs**: audit records and stderr events are single-line JSON (`console.error(JSON.stringify({ event, ... }))`).
  The stdio server's stdout is the MCP protocol: never `console.log` there.
- **Docs**: MkDocs Material, built with `--strict` (any broken link or anchor fails). `README.md`, `SKILL.md`
  and `PLAN.md` are included into the site through wrapper pages (`docs/install.md`, `docs/agent-skill.md`,
  `docs/plan.md`), so links in those root files must resolve too. See docs/CLAUDE.md.
- **Pins move together**: Bun 1.4.2, Node 22, Python 3.12, `markitdown[...]==0.1.5`, `litellm[mcp]==1.104.0`
  appear in workflows, Dockerfiles and docs. Change all of them in one PR.
- **Commits**: describe the change and reference the issue. Never put AI model identifiers in code,
  comments, docs, PR titles or PR bodies; the `Co-Authored-By` trailer the tooling appends to commits is
  the only place one may appear.

## Platform policy

- The stdio server supports Windows: keep its win32 paths (`.venv/Scripts`, `path.delimiter`, no `O_NOFOLLOW`)
  working; `.github/workflows/cross-platform.yml` tests it on macOS and Windows.
- The remote server is Linux-only. It refuses to start on win32 (`WINDOWS_UNSUPPORTED_MESSAGE` in
  `src/remote/config.ts`, used by `index.ts` and `purge-owner.ts`). Do not add win32 code under `src/remote/`
  and do not run remote tests on Windows or macOS runners.

## Where things live

- `src/` - stdio server (`index.ts`, `server.ts`, `tools.ts`, `schemas.ts`, `Markdownify.ts`, `utils.ts`, `download.ts`); `src/sample-data/` test fixtures. See src/CLAUDE.md.
- `src/remote/` - remote HTTP service (config, auth/JWT, http, jobs, converter, audit, health, errors). See src/remote/CLAUDE.md.
- `scripts/` - operator credential tool, CI fixtures, smoke tests (TS, Python, shell). See scripts/CLAUDE.md.
- `examples/` - `upload-and-convert.ts`, the documented streaming client (shipped in the image). See examples/CLAUDE.md.
- `docs/` - MkDocs site sources; `mkdocs.yml`, `mkdocs_hooks.py` at the root. See docs/CLAUDE.md.
- `.github/workflows/` - CI and publication. See .github/workflows/CLAUDE.md.
- `Dockerfile` - stdio server image (Bun runtime, `markitdown[all]`); `Dockerfile.remote` - remote service image (Node 22 + Python 3.12, UID 10001).
- `compose.remote.yaml` (single API key), `compose.multitenant.yaml` (agent registry), `compose.jwt.yaml` (LiteLLM JWT).
- `.env.remote.example`, `.env.multitenant.example`, `.env.jwt.example` - templates for the matching compose file; real `.env.*` files and `secrets/` are never committed.
- `SKILL.md` - agent skill that runtimes load to use the remote service; `PLAN.md` - milestone plan. Both render on the docs site.
- `pyproject.toml`, `uv.lock`, `.python-version` - the Python side (`.venv`); `setup.sh`/`setup.bat`/`preinstall.js` - the npm preinstall hook.

## Git workflow

- PRs target `main`. Do not push or commit unless asked.
- CI on every push and PR: **Remote MVP** (`remote-mvp.yml`: Linux, full tests, smokes, Docker builds and
  container checks) and **Cross-platform** (`cross-platform.yml`: stdio tests on macOS and Windows).
  **Docs** (`docs.yml`) runs on doc-related paths and deploys GitHub Pages from `main` (Pages source: GitHub Actions).
  **Docker Hub publication** (`docker-publish.yml`) runs on `main` only: re-tests, then pushes `latest` and `sha-<SHA>`.
- Docker is not available in the Claude cloud container: Docker and compose steps are verified by CI only.
  Say so in the PR description when you change them.

## Before you finish

1. `bun run typecheck`
2. `bun run build` and `bun run build:remote`
3. `bun test` (all green; skips only for the documented reasons)
4. Docs, README.md, SKILL.md or PLAN.md changed: `python mkdocs_hooks.py` and `mkdocs build --strict` (commands above).
5. Shell changed: `bash -n` on each changed script (CI also runs `shellcheck -x scripts/*.sh setup.sh`;
   locally `uvx --from shellcheck-py shellcheck -x scripts/*.sh setup.sh`).
6. Workflow changed: `python3 -c 'import sys,yaml; [yaml.safe_load(open(f)) for f in sys.argv[1:]]' .github/workflows/*.yml`.
7. Python scripts changed: run them with and without `-O`; `grep -nE '^\s*assert ' scripts/*.py` prints nothing.
8. Line endings: `git diff --check` is clean; after `git add`, `git ls-files --eol | grep 'i/crlf'` prints nothing.
