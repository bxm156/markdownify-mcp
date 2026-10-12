# Testing

How to run every kind of test in this repository. Commands run from the repo root. Agent-facing
conventions are in CLAUDE.md; per-folder notes in src/CLAUDE.md, src/remote/CLAUDE.md and scripts/CLAUDE.md.

## Quick reference

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run build && bun run build:remote
bun test                                   # all Bun tests (stdio + remote + scripts)
bun test src/remote                        # remote only (= bun run test:remote)
bun test src/remote/jobs.test.ts           # one file
bun test src/remote/errors.test.ts -t "output limit"   # tests whose name matches a regex
bun scripts/remote-converter-smoke.ts      # real MarkItDown, no server (= bun run test:converter)
bun scripts/jwt-http-smoke.ts              # compiled Node server, JWT auth, real conversions
```

## Prerequisites

| Need | For | Install / check |
| --- | --- | --- |
| Bun 1.4.2 | everything | `bun --version` |
| Node 24 (24.2+) on PATH, the only supported major (`engines.node`) | `src/download.test.ts` (runs `node --experimental-strip-types`; its 1024-bit-key TLS case expects a verification error, so a Node 22 on PATH fails it), compiled-entry tests in `src/remote/cleanup.test.ts` (skipped without `node`), all HTTP smokes | `node --version` |
| `.venv` with markitdown 0.1.5 | stdio converter tests (skipped without it), converter and HTTP smokes | see below; check `.venv/bin/markitdown --version` |
| `litellm[mcp]==1.104.0` | `scripts/litellm-health-smoke.py` and its test only | separate venv, see [LiteLLM](#litellm-health-smoke) |
| MkDocs (`docs/requirements.txt`) | docs build only | separate venv, see [Docs](#docs-build) |
| Docker + Compose | image, container and compose checks only | not available in the Claude cloud container (no daemon); CI covers them |

Install JS dependencies with `--ignore-scripts`. Without it, Bun runs the `preinstall` hook (`setup.sh`), which
re-creates `.venv` with the system `python3` and an unpinned `markitdown[all]>=0.1.5`.

Create `.venv` (any one of):

```sh
uv sync                                    # pyproject.toml + uv.lock (markitdown[all]==0.1.5), Python from .python-version (3.12)
./setup.sh                                 # python3 -m venv .venv; pip install "markitdown[all]==0.1.5"
python3 -m venv .venv && .venv/bin/pip install 'markitdown[pdf,docx,xlsx,pptx]==0.1.5'   # exactly what CI pins
```

`uv.lock` matches `pyproject.toml` (`uv lock --check` passes); if you change the Python dependencies, run `uv lock`
and commit the lock with them. Windows: `setup.bat`, converter at `.venv\Scripts\markitdown.exe`.

## Test layout

| Location | Runner | What |
| --- | --- | --- |
| `src/*.test.ts` | `bun test` | stdio server: tools/schemas, server dispatch, `Markdownify`, `utils` (allowlist, SSRF), `download` (pinned fetch), `index` (stdio JSON-RPC child), `proxyWarning` |
| `src/remote/*.test.ts` | `bun test` | remote service: config, auth/JWT, HTTP edges, jobs lifecycle, quotas, audit, health, errors, cleanup CLI, entry point |
| `src/remote/test-helpers.ts` | imported by remote tests | `waitFor`, `closedPort`, `toolJson`/`toolOk`/`toolErrorCode`, `mcpInitialize`, `createJwtFixture` |
| `scripts/*.test.ts` | `bun test` | `create-test-agent-registry.test.ts` |
| `scripts/*_test.py` | `python` | `create_remote_fixtures_test.py`, `litellm_health_smoke_test.py` |
| `scripts/docker-smoke-test.test.sh` | `bash` | `wait_for_response` from `docker-smoke-test.sh`, no Docker |
| `scripts/*-smoke.ts`, `scripts/*-smoke.py`, `scripts/docker-smoke-test.sh` | manual / CI | end-to-end smokes (below) |

`bun test` finds every `*.test.ts` under the repo (not `node_modules`). Path arguments are substring filters:
`bun test src/remote/jobs` runs `jobs.test.ts`, `jobs-failures.test.ts` and `jobs-lifecycle.test.ts`.

## Running Bun tests

```sh
bun test                                   # everything
bun test src/remote                        # a directory
bun test src/Markdownify.test.ts           # a file
bun test src/remote/errors.test.ts -t "output limit"   # -t / --test-name-pattern: regex on the full test name
bun test --watch src/remote/config.test.ts # re-run on file change (= bun run test:watch for everything)
bun test --bail                            # stop at the first failure
bun test src/remote/jobs.test.ts --rerun-each 3        # flake hunting: runs each file 3 times (21 tests -> 63)
bun test --randomize                       # random order; reproduce with --seed=<n>
bun test --reporter=junit --reporter-outfile=junit.xml # per-file timings and skipped tests
```

`-t` matching nothing exits non-zero (`regex "..." matched 0 tests`). The default per-test timeout is 5000 ms
(`--timeout`); slow tests set their own. The console reporter does not list skipped tests when output is not a
TTY; use the junit reporter to see them. Expected noise: single-line JSON such as
`{"event":"audit_sink_unavailable",...}` on stderr comes from audit failure tests, not from failures.

## Environment variables

| Variable | Effect on tests |
| --- | --- |
| `MD_TEST_NETWORK=1` | Enables the 12 `Markdownify.fromRepo` git-clone tests in `src/Markdownify.test.ts` (clone public GitHub repos via repomix). Must be exactly `1`; anything else skips them. CI sets it in Remote MVP. |
| `MARKITDOWN_PATH` | Converter used by the code and by the `converterTest` skip check. Point it at a missing file to force the converter tests to skip (`MARKITDOWN_PATH=/nonexistent bun test src/Markdownify.test.ts`: 21 skipped). Tests that set it themselves restore it. |
| `TMPDIR` (`TEMP`, `TMP`) | Tests create temp dirs under `os.tmpdir()` and remove them; set `TMPDIR` to isolate a run. `src/Markdownify.test.ts` redirects all three to a private dir and asserts nothing is left behind. |
| `REPOMIX_PATH`, `MD_ALLOWED_PATHS`, `MD_SHARE_DIR`, `HTTP(S)_PROXY` | Set and restored by individual stdio tests; leave them unset in your shell. |
| `PYTHON_PATH` | Python used by `remote-converter-smoke.ts` for fixtures (default `.venv/bin/python`, then `python`). |
| `MD_TEST_NODE` | Node binary spawned by `jwt-http-smoke.ts` and `litellm-health-smoke.py` (default `node`). |
| `MCP_URL`, `MCP_TOKEN` / `MD_API_KEY`, `MD_TEST_AGENT_KEYS` | Target and credentials of the HTTP smokes (below). |

## What is skipped, and why

| Skip | Condition | Where |
| --- | --- | --- |
| Git-clone tests (12) | `MD_TEST_NETWORK` is not `1` | `src/Markdownify.test.ts` |
| Real-converter tests (9) | markitdown not found (same lookup as production) | `src/Markdownify.test.ts` |
| Read-only data dir test (1) | running as root (`process.getuid() === 0`): root ignores mode bits. The Claude cloud container runs as root; GitHub runners do not, so CI executes it. | `src/remote/cleanup.test.ts` |
| Compiled entry points under node | no `node` on PATH | `src/remote/cleanup.test.ts` |
| Symlink / FIFO / rename tests | `process.platform === "win32"` | `src/utils.test.ts`, `src/Markdownify.test.ts` |
| `/proc/self/fd` variants | not Linux | `src/utils.test.ts` |

A normal local run on Linux as root with `.venv` present shows 13 skips (12 network + 1 root).

## Type checking

`bun run typecheck` (`tsc --noEmit -p tsconfig.check.json`) checks `src/` including tests and
`test-helpers.ts`, `scripts/**/*.ts` and `examples/**/*.ts`. `bun test` does not type-check, so run it with
every test change. `bun run build` / `bun run build:remote` use `tsconfig.json` and exclude tests.

## Smoke scripts

All need `bun install`; the HTTP ones also need `bun run build:remote`, Node 24 and markitdown in `.venv` or on PATH.

### remote-converter-smoke

In-process `JobService` with real MarkItDown on `src/sample-data/test.pdf` and generated DOCX/XLSX/PPTX
(needs openpyxl and python-pptx in the Python it uses). No server, no build.

```sh
bun scripts/remote-converter-smoke.ts      # or: bun run test:converter   (~5 s)
```

### jwt-http-smoke

Self-contained: spawns `node dist/remote/index.js` on a random port with a local JWKS, checks RS256 auth, scoped
uploads, three-agent isolation and `examples/upload-and-convert.ts` through a fake gateway.

```sh
bun run build:remote && bun scripts/jwt-http-smoke.ts   # ~6 s
```

### remote-http-smoke (single API key)

Needs a running server. CI runs it against the container; locally against Node:

```sh
bun run build:remote
dir=$(mktemp -d); export MD_API_KEY=$(openssl rand -hex 32)
MD_PUBLIC_BASE_URL=http://localhost:8000 MD_DATA_DIR="$dir" node dist/remote/index.js & server=$!
until curl -fs http://localhost:8000/readyz >/dev/null; do sleep 0.2; done
MCP_TOKEN="$MD_API_KEY" bun scripts/remote-http-smoke.ts
MCP_TOKEN="$MD_API_KEY" CONVERSION_DEADLINE_MS=120000 bun examples/upload-and-convert.ts src/sample-data/test.pdf "$dir/out.md"
grep -q 'Test PDF content' "$dir/out.md" && echo example ok
kill "$server"
```

### multitenant-http-smoke (agent registry)

```sh
bun run build:remote
dir=$(mktemp -d)
bun scripts/create-test-agent-registry.ts "$dir/agents.json" "$dir/env" >/dev/null   # prints ::add-mask:: lines
export MD_TEST_AGENT_KEYS="$(sed -n 's/^MD_TEST_AGENT_KEYS=//p' "$dir/env")"
MD_AUTH_FILE="$dir/agents.json" MD_PUBLIC_BASE_URL=http://localhost:8000 MD_DATA_DIR="$dir/data" \
  node dist/remote/index.js & server=$!
until curl -fs http://localhost:8000/readyz >/dev/null; do sleep 0.2; done
bun scripts/multitenant-http-smoke.ts
kill "$server"
```

Use another port by setting `MD_PORT`, `MD_PUBLIC_BASE_URL` and `MCP_URL` (`http://localhost:<port>/mcp`) together.

### litellm-health-smoke

Runs LiteLLM 1.104.0's real anonymous health client against a spawned JWT-mode server (random port). Requires
exactly `litellm[mcp]==1.104.0`, so use its own venv:

```sh
bun run build:remote
python3 -m venv /tmp/litellm-venv && /tmp/litellm-venv/bin/pip install 'litellm[mcp]==1.104.0'
/tmp/litellm-venv/bin/python scripts/litellm-health-smoke.py        # ~5 s
/tmp/litellm-venv/bin/python -O scripts/litellm-health-smoke.py
/tmp/litellm-venv/bin/python -O scripts/litellm_health_smoke_test.py   # negative paths: 403, 500, timeout, success
/tmp/litellm-venv/bin/python scripts/litellm-health-smoke.py --self-test   # classifier only, no server
```

### Docker smokes (CI only here)

Docker is not available in the Claude cloud container; these were not run locally.

```sh
bash scripts/docker-smoke-test.sh          # builds Dockerfile (stdio), converts test.pdf over stdio; IMAGE, SMOKE_TIMEOUT
docker build -f Dockerfile.remote -t markdownify-remote:ci .
export MD_API_KEY=$(openssl rand -hex 32)
docker run -d --name markdownify-ci -p 127.0.0.1:8000:8000 -e MD_API_KEY -e MD_PUBLIC_BASE_URL=http://localhost:8000 markdownify-remote:ci
bash scripts/wait-for-container.sh markdownify-ci   # waits for /readyz and HEALTHCHECK healthy (90 s), then run the HTTP smokes
```

`docker compose -f compose.<remote|multitenant|jwt>.yaml config -q` needs no daemon but needs `.env.remote`,
`.env.multitenant`, `.env.jwt` (copy the `.example` files) and `secrets/agents.json`; CI creates them. Do it in a
scratch copy, since `.env.multitenant` and `.env.jwt` are not gitignored.

## Python and shell script tests

```sh
.venv/bin/python scripts/create_remote_fixtures_test.py       # needs openpyxl, python-pptx
.venv/bin/python -O scripts/create_remote_fixtures_test.py
grep -nE '^\s*assert ' scripts/*.py                           # CI guard: must print nothing
bash scripts/docker-smoke-test.test.sh                        # no Docker needed
for f in scripts/*.sh setup.sh; do bash -n "$f"; done
uvx --from shellcheck-py shellcheck -x scripts/*.sh setup.sh  # CI uses the runner's shellcheck
```

## Docs build

```sh
python3 -m venv /tmp/mkdocs-venv && /tmp/mkdocs-venv/bin/pip install -r docs/requirements.txt
/tmp/mkdocs-venv/bin/python mkdocs_hooks.py                    # hook self-check
NO_MKDOCS_2_WARNING=true /tmp/mkdocs-venv/bin/mkdocs build --strict -d /tmp/site-check   # ~1 s
```

Run it when `docs/`, `mkdocs.yml`, `mkdocs_hooks.py`, `README.md`, `SKILL.md`, `PLAN.md` or a file they link to changes.

## What CI runs

| Workflow | Trigger | Commands |
| --- | --- | --- |
| Remote MVP (`remote-mvp.yml`), job `remote` (required status check) | every push, PR; Node 24 | Node 24 check; `bun install --frozen-lockfile --ignore-scripts`; `bun run typecheck`; bare-assert grep; `bun run build:remote`; `bun test src/remote`; pip `markitdown[pdf,docx,xlsx,pptx]==0.1.5`; `bun run build`; `MD_TEST_NETWORK=1 bun test`; fixture test (plain and `-O`); converter and JWT smokes, JWT again with `NODE_OPTIONS=--throw-deprecation`; LiteLLM smoke (plain and `-O`) and `-O` negative test; `docker build -f Dockerfile.remote --build-arg NODE_IMAGE=node:24-bookworm-slim`; image `node -p process.version` and `ldd` check; container + `wait-for-container.sh` + `remote-http-smoke.ts` + example; registry container + `multitenant-http-smoke.ts` + example |
| Remote MVP, job `stdio-and-compose` | every push, PR | `bash -n`; `shellcheck -x`; `docker-smoke-test.test.sh`; `docker compose config -q` x3; `docker-smoke-test.sh` |
| Cross-platform (`cross-platform.yml`) | every push, PR; macOS + Windows | markitdown 0.1.5 on PATH; `bun run typecheck`; `bun test src/utils.test.ts src/Markdownify.test.ts src/download.test.ts src/server.test.ts src/tools.test.ts` |
| Docs (`docs.yml`) | PRs and `main` pushes touching doc paths | `pip install -r docs/requirements.txt`; `python mkdocs_hooks.py`; `mkdocs build --strict`; deploys Pages from `main` |
| Docker Hub publication (`docker-publish.yml`) | push to `main`, manual | typecheck, both builds, `bun test src/remote`, `bun test` (no `MD_TEST_NETWORK`), converter/JWT (also `--throw-deprecation`)/LiteLLM smokes, shellcheck, `docker-smoke-test.test.sh`, fixture test; builds the image, checks its Node 24 and `ldd`, tests it with three agents, then pushes |

All Linux jobs pin Bun 1.4.2 and Python 3.12. Node: 24 everywhere (publication, Cross-platform and Remote MVP's `remote` job; its `stdio-and-compose` job needs no Node).

## Timing (observed 2026-10-11, Linux, as root, `.venv` present)

- `bun test`: 598 tests in 34 files, 585 pass, 13 skip, 36-41 s.
- `bun test src/remote`: 276 tests in 26 files, 1 skip, 17-19 s.
- `MD_TEST_NETWORK=1 bun test src/Markdownify.test.ts -t fromRepo`: 16 tests, ~25 s (network bound).
- Slowest files: `src/Markdownify.test.ts` ~14 s (real markitdown), `src/remote/cleanup.test.ts` ~6 s (runs
  `bun run build:remote`, then `node`), `src/download.test.ts` ~4 s, `src/remote/index.test.ts` ~4 s.
  Everything else is under ~1 s.
- `bun run typecheck` ~4 s; each build ~3 s.

Counts grow; treat these as orders of magnitude.

## Writing new tests

- Put `<module>.test.ts` next to the module, import from `bun:test`. Remote tests import helpers from
  `./test-helpers.js`; never import `test-helpers.ts` from production code or scripts.
- No fixed sleeps. Wait for state with `waitFor(() => condition, { timeoutMs, label })`, which returns the
  truthy value; control time with `setSystemTime(...)` and reset it (`setSystemTime()`) in `afterEach`.
- Assert codes, not text: `toolErrorCode(result)` for `error_info.code`, `ServiceError.code`, HTTP status.
- Isolate: `fs.mkdtemp(path.join(os.tmpdir(), "markdownify-..."))` and remove it in `afterEach`; listen on port 0
  at `127.0.0.1`; use `closedPort()` for a refused port; `createJwtFixture()` and call `close()` in `afterEach`.
- Restore every environment variable you set. Spawn children with `process.execPath`, or `node` from PATH
  only behind `describe.skipIf(!Bun.which("node"))`.
- Guard platform or privilege assumptions with `test.skipIf(...)` (win32, non-Linux, root), never by deleting checks.
- Stdio file-race tests use `_fileAccessTestHooks` in `src/utils.ts` instead of timing.
- After writing a test, break the code under test once and confirm the test fails.
