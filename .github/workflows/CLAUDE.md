# CLAUDE.md (.github/workflows/)

Guidance for agents editing CI. GitHub only runs `*.yml`/`*.yaml` here; this
file is documentation. Pinned everywhere: Bun 1.4.2, Node 22, Python 3.12,
markitdown 0.1.5 (`markitdown[pdf,docx,xlsx,pptx]==0.1.5`), LiteLLM 1.104.0
(`litellm[mcp]==1.104.0`). `Dockerfile.remote` pins
Node 22, Python 3.12 and `markitdown[pdf,docx,xlsx,pptx]==0.1.5`. The stdio
`Dockerfile` pins Bun 1.4.2 and `markitdown[all]==0.1.5` (audio/OCR tools) and uses
the base image's Debian `python3` (`oven/bun:1.4.2-debian` is trixie, so 3.13) plus
ffmpeg, deliberately without a second Python toolchain. Change a pin in every
workflow and Dockerfile together. All
workflows use `permissions: contents: read` unless stated.

## remote-mvp.yml ("Remote MVP")

Triggers: every `push` and `pull_request`. No secrets.

- Job `remote` (15 min): `bun install --frozen-lockfile --ignore-scripts`;
  `bun run typecheck` (tests, scripts, examples); `bun scripts/check-env-docs.ts`
  (every `MD_*` in `src/remote` is in the `docs/REMOTE.md` table); an `ast`-based guard that
  fails on any `assert` statement in `scripts/*.py` and `mkdocs_hooks.py` (`python -O`
  strips them, use `raise`);
  `bun run build:remote`; `bun test src/remote`; install markitdown; `bun run
  build`; full `bun test` with `MD_TEST_NETWORK=1`; fixture generator test
  (`create_remote_fixtures_test.py`, also under `-O`); `remote-converter-smoke.ts`
  and `jwt-http-smoke.ts` against the compiled Node server; LiteLLM 1.104
  anonymous health smoke (`litellm-health-smoke.py`, also under `-O`) and
  `litellm_health_smoke_test.py` under `-O` (rejects 403, 500, timeout,
  unexpected success). Then `docker build -f Dockerfile.remote`, and two
  containers: single-key (`remote-http-smoke.ts` plus `examples/upload-and-convert.ts`
  on `src/sample-data/test.pdf`) and a disposable three-agent registry
  (`create-test-agent-registry.ts`, `multitenant-http-smoke.ts`, the example as agent "a").
  Each container waits with `scripts/wait-for-container.sh <name>`, which needs
  `/readyz` 200 and Docker HEALTHCHECK `healthy` (90 s default; dumps health log
  and container logs on failure). Containers are removed by an `EXIT` trap.
- Job `stdio-and-compose` (25 min): `bash -n` on `scripts/*.sh` and `setup.sh`;
  `shellcheck -x`; `scripts/docker-smoke-test.test.sh` (no Docker needed);
  `docker compose config -q` for compose.remote/multitenant/jwt using copies of
  `.env.*.example` and a placeholder `secrets/agents.json`; then
  `scripts/docker-smoke-test.sh` (builds the stdio `Dockerfile`, converts a PDF over stdio).

## docker-publish.yml ("Docker Hub publication")

Triggers: `push` to `main` and `workflow_dispatch`; job guarded by
`github.ref == 'refs/heads/main'`. Concurrency group `dockerhub-main`, never
cancelled. Job `test-and-publish`, 25 min.

- Re-runs the cheap or image-relevant source checks (typecheck, env docs check,
  assert guard, build, `MD_TEST_NETWORK=1 bun test`, converter/JWT/LiteLLM smokes,
  `bash -n`, shellcheck, the stdio smoke's Docker-free test, fixture test, `docker compose config -q`
  for the three compose files). It relies on remote-mvp.yml for `docker-smoke-test.sh`
  (a second image build of the unpublished stdio Dockerfile), the single-key container
  smoke, and the LiteLLM `-O` run and negative-path harness. Then it builds
  `Dockerfile.remote` (linux/amd64, `VCS_REF=$GITHUB_SHA`, `load: true`,
  `push: false`) without registry credentials, and tests that image with three
  disposable agents: the multitenant smoke, then `examples/upload-and-convert.ts` as
  agent "a" under Bun, under Node (`--experimental-strip-types`) and the compiled
  `examples/upload-and-convert.js` inside the image (`--network container:<name>`),
  the same three runs as remote-mvp.yml's single-key step.
- A "Check publication configuration" step sets `ready=true` only if secrets
  `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` exist, `IMAGE_NAME` is valid
  (`bryanmarty/markdownify-mcp`), and `main` has not advanced past `$GITHUB_SHA`
  (`git ls-remote`). Otherwise it reports a skip in the step summary and stays green.
- Only then: `docker/login-action`, then tag and push the same tested image as
  `sha-<full SHA>` and `latest`. No rebuild after testing. Secrets are used
  only in the config check and the login step.

## docs.yml ("Docs")

Triggers: `pull_request` and `push` to `main`, both limited to `paths:`
(docs, `mkdocs.yml`, `mkdocs_hooks.py`, README/SKILL/PLAN, LICENSE,
`examples/**`, `compose*.yaml`, `.env*.example`, `Dockerfile.remote`,
`scripts/**`, `src/remote/**`, `docker-publish.yml`, `docs.yml`,
`remote-mvp.yml`), plus `workflow_dispatch`. Job `build` (10 min): Python 3.12 with
pip cache, `pip install -r docs/requirements.txt`, `python mkdocs_hooks.py`,
`mkdocs build --strict`; uploads the Pages artifact only on `main`. Job
`deploy` (10 min, `needs: build`, main only, concurrency group `pages` without
cancel) has `pages: write`, `id-token: write`, environment `github-pages`, and
runs `configure-pages` (`enablement: true`) and `deploy-pages`.

## cross-platform.yml ("Cross-platform")

Triggers: every `push` and `pull_request`. Matrix `macos-latest`,
`windows-latest`, `fail-fast: false`, 20 min. Installs real markitdown so
converter tests run instead of skipping, checks `markitdown` and
`Bun.which('markitdown')` resolve on PATH, then `bun run typecheck`, `bun run build`
(so the platform-neutral chmod step runs on Windows) and the stdio tests only, which
is every file in `src/*.test.ts`: `utils`, `Markdownify`, `download`, `server`,
`tools`, `index`, `proxyWarning`.
Remote tests (`src/remote`) are deliberately excluded: the remote server is Linux-only.

## Rules

- Validate YAML locally: `uv run --no-project --with pyyaml python -c "import sys,yaml; [yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/*.yml`.
- Keep LF line endings. Use `bun`, never npm/pnpm/yarn, in steps.
- Do not add Windows (or macOS) runners for remote tests.
- `docker-publish.yml` repeats most `remote-mvp.yml` checks before the push; when
  you add a check that should gate publishing, add it to both.
- A new script used in CI that affects docs (linked or documented) must also be
  added to the `paths:` filter in `docs.yml` (both `pull_request` and `push`).
- Docker steps cannot run in the Claude cloud container. Say so in the PR
  description and rely on CI for container steps.
- Keep each job under its `timeout-minutes`; raise the timeout deliberately if
  you add steps, and prefer fewer container starts.
