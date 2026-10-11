# scripts/

Operator tools, CI fixtures and smoke tests for the remote server. Run everything from the repo root with Bun (not npm/pnpm/yarn). "Built dist" means `bun run build:remote` (output in `dist/remote/`, gitignored). Smokes that spawn or call the server also need MarkItDown reachable (`.venv/bin` or PATH, or `MARKITDOWN_PATH`).

## Scripts

**create-agent-credential.ts** (operator-only, never an MCP tool). Appends one hashed agent to a registry and writes the raw token to a new file (mode 0600, refuses to overwrite).
`bun scripts/create-agent-credential.ts <tenant> <agent> secrets/agents.json secrets/agent.token`. Needs only Bun. Not in CI; documented in README, docs/QUICKSTART.md, docs/MULTITENANT.md.

**create-test-agent-registry.ts** (+ `.test.ts`). CI-only. Writes a hash-only registry for agents a, b (tenantA) and c (tenantB), prints `::add-mask::<token>` for each, appends `MD_TEST_AGENT_KEYS={"a":..,"b":..,"c":..}` to the given env file. Fails if the registry already exists.
`bun scripts/create-test-agent-registry.ts "$RUNNER_TEMP/markdownify-agents.json" "$GITHUB_ENV"`. Test: `bun test scripts/create-test-agent-registry.test.ts` (also picked up by root `bun test`). Needs only Bun. CI: remote-mvp.yml "Prepare disposable agent registry"; docker-publish.yml "Prepare disposable agent credentials".

**create-remote-fixtures.py** (+ `create_remote_fixtures_test.py`). Writes real OOXML `test.docx/xlsx/pptx` into a directory (created if missing). Needs `openpyxl` and `python-pptx` (from `markitdown[pdf,docx,xlsx,pptx]==0.1.5`). Called by remote-converter-smoke.ts.
`python scripts/create-remote-fixtures.py /tmp/fixtures`; with no argument it prints a usage line to stderr and exits 2; test: `python scripts/create_remote_fixtures_test.py` and `python -O scripts/create_remote_fixtures_test.py`. CI: remote-mvp.yml "Test the Office fixture generator"; docker-publish.yml same step.

**check-env-docs.ts**. Cross-checks every `MD_*` name in non-test `src/remote/*.ts` against the variable table in `docs/REMOTE.md`; lists the missing ones and exits 1. Needs only Bun. `bun scripts/check-env-docs.ts`. CI: remote-mvp.yml and docker-publish.yml, right after the typecheck.

**docker-smoke-test.sh** (+ `docker-smoke-test.test.sh`). DOCKER REQUIRED for the script: builds the stdio `Dockerfile`, mounts `src/sample-data`, converts `test.pdf` via `pdf-to-markdown` over stdio, expects "Test PDF content". Env: `IMAGE` (default `markdownify-mcp:smoke`), `SMOKE_TIMEOUT` (default 60 s).
`bash scripts/docker-smoke-test.sh`. The test file needs no Docker (sources the script, tests `wait_for_response`): `bash scripts/docker-smoke-test.test.sh`. CI: remote-mvp.yml job `stdio-and-compose` (script with `IMAGE=markdownify-mcp:ci`, test file); docker-publish.yml runs the test file only.

**wait-for-container.sh**. DOCKER REQUIRED. Polls `<base>/readyz` and `docker inspect` health until both pass; on failure dumps health and logs, exit 1.
`bash scripts/wait-for-container.sh <container> [base-url=http://localhost:8000] [timeout=90]`. CI: before every container smoke in remote-mvp.yml and docker-publish.yml.

**remote-converter-smoke.ts** (`bun run test:converter`). In-process `JobService` against real MarkItDown for pdf/docx/xlsx/pptx; generates fixtures first. No server, no dist needed. Python: `$PYTHON_PATH`, else `.venv/bin/python`, else `python`.
`bun scripts/remote-converter-smoke.ts`. CI: remote-mvp.yml; docker-publish.yml.

**remote-http-smoke.ts** (`bun run test:http-smoke`). Single-tenant HTTP flow (list tools, `lookup_error`, binary PUT upload, convert, paginated read, delete) against a running server. Needs a server (default `MCP_URL=http://localhost:8000/mcp`) started with `MD_API_KEY` and `MD_PUBLIC_BASE_URL=http://localhost:8000`; the script reads `MCP_TOKEN` (or `MD_API_KEY`).
`MCP_TOKEN=$MD_API_KEY bun scripts/remote-http-smoke.ts`. CI: remote-mvp.yml "Verify container HTTP upload workflow" only (against the Docker container).

**multitenant-http-smoke.ts**. Three-agent isolation test (a, b same tenant; c other tenant) against a server using `MD_AUTH_FILE`. Needs `MD_TEST_AGENT_KEYS` (JSON with a, b, c, each at least 32 chars) matching the registry; optional `MCP_URL`.
Local: `bun scripts/create-test-agent-registry.ts /tmp/agents.json /tmp/env.txt`, start `MD_AUTH_FILE=/tmp/agents.json MD_PUBLIC_BASE_URL=http://localhost:8000 node dist/remote/index.js`, then `MD_TEST_AGENT_KEYS="$(sed 's/^MD_TEST_AGENT_KEYS=//' /tmp/env.txt)" bun scripts/multitenant-http-smoke.ts`. CI: remote-mvp.yml "Verify container agent isolation"; docker-publish.yml "Test candidate container".

**jwt-http-smoke.ts**. Self-contained: needs built dist and MarkItDown, spawns `node dist/remote/index.js` on a random 127.0.0.1 port with a local JWKS and RS256 fixture, tests scoped uploads, cross-agent isolation, and runs `examples/upload-and-convert.ts` through a fake LiteLLM gateway. Optional env: `MD_TEST_NODE` (node binary), `MD_TEST_LITELLM_SIGNER_FIXTURE` (JSON from a real LiteLLM signer).
`bun scripts/jwt-http-smoke.ts`. CI: remote-mvp.yml "Verify compiled Node JWT authentication"; docker-publish.yml.

**litellm-health-smoke.py** (+ `litellm_health_smoke_test.py`). Runs LiteLLM 1.104.0's real anonymous health client against a spawned JWT-mode server (random port, needs built dist, MarkItDown, `litellm[mcp]==1.104.0`; exits if the version differs). Policy: anonymous `initialize`/ping must succeed and anonymous `tools/list` must fail with HTTP 401 and no other status anywhere in the exception chain/groups (403, 500, timeouts, transport errors fail; message text is never matched).
`python scripts/litellm-health-smoke.py`; `--self-test` runs only the classifier regression cases (still needs litellm installed). Negative-path harness (fake server answering 403/500/timeout/success): `python -O scripts/litellm_health_smoke_test.py`. CI: remote-mvp.yml (smoke with and without `-O`, harness with `-O`); docker-publish.yml runs the smoke only.

## Rules for this folder

- Python must survive `python -O`: no `assert` statements (CI parses `scripts/*.py` with `ast` and fails on any `Assert` node, in any form; the word in comments and strings is fine). Use an explicit `raise` or the local `check()` helper. `mkdocs_hooks.py` is not yet covered (TODO #70).
- Shell scripts must pass `bash -n` and `shellcheck -x` (CI covers `scripts/*.sh` and `setup.sh`). Keep them sourceable-safe (`main` guarded by `BASH_SOURCE`) if they have a Docker-free test.
- TypeScript is run with `bun` and type-checked by `bun run typecheck` (`tsconfig.check.json` includes `src`, `scripts`, `examples`). Run it after any edit.
- Never print secrets: no tokens, `Authorization` headers, `create_upload` results or env dumps. CI tokens are masked with `::add-mask::` before use. Credential files are written 0600 with exclusive create.
- Do not import `src/remote/test-helpers.ts` (test-only). Currently no script does. Importing other `src/remote/*` modules (auth, identity, jobs, errors) is fine.
- LF line endings only (`.gitattributes`).
- Adding a script: wire it into `.github/workflows/remote-mvp.yml` (main job after `bun run build:remote`; Docker steps after the image build), and into `docker-publish.yml` if it gates publishing. Give it a `package.json` script only if it is a routine dev command. Add its test beside it (`*.test.ts` is picked up by `bun test`; Python and shell tests need explicit CI steps). Document the command in the matching docs/*.md.
