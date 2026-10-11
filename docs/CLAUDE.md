# CLAUDE.md (docs/)

Guidance for agents editing the documentation site. This file is excluded from
the site (`exclude_docs` in `mkdocs.yml`); keep that entry or `--strict` fails.

## The site

- MkDocs Material, `docs_dir: docs`, config in `/mkdocs.yml`, hook in `/mkdocs_hooks.py`.
- Built with `mkdocs build --strict`: every warning (broken link or anchor, page
  missing from `nav`, repo link to a missing file) is a build failure.
- `.github/workflows/docs.yml` builds on PRs and deploys to GitHub Pages from
  `main` (Pages source = GitHub Actions). Live at https://bxm156.github.io/markdownify-mcp/.
- Build locally (the `site/` output is gitignored):

```sh
python -m venv /tmp/docs-venv && . /tmp/docs-venv/bin/activate
pip install -r docs/requirements.txt
python mkdocs_hooks.py            # hook self-check, no build needed
NO_MKDOCS_2_WARNING=true mkdocs build --strict -d /tmp/site-check
```

## Wrapper pages and the link hook

`install.md`, `agent-skill.md` and `plan.md` hold only an `include-markdown`
directive plus a "Source" note; the content lives in `README.md`, `SKILL.md`
and `PLAN.md`. Edit those root files, never the wrapper bodies. The plugin
rewrites relative links of included files relative to the wrapper, then
`mkdocs_hooks.py` (runs after the plugin) handles links that leave `docs/`:

- a link to `README.md`, `SKILL.md` or `PLAN.md` becomes a link to its wrapper page;
- any other existing repo file becomes `<repo_url>/blob/main/<path>` (directories: `/tree/main/`);
- a link to a repo path that does not exist logs a warning, which fails `--strict`;
- fenced code and inline code spans are left alone; only inline `[text](target)`
  links/images are rewritten (not reference definitions or raw HTML);
- links inside `docs/` are untouched and validated by MkDocs; it also points a
  wrapper's "Edit this page" at the included source file.

Adding another included root file means extending `WRAPPED_PAGES` in the hook
and its self-check.

## Rules

- Every relative link must resolve under `--strict`. Do not link to files
  outside the repository.
- A new page must be added to `nav` in `mkdocs.yml` (or to `exclude_docs`).
- Anchors are GitHub-style slugs (`pymdownx.slugs.slugify`, lower case), so
  `README.md#some-heading` works on both GitHub and the site. Renaming a
  heading breaks inbound anchors; grep for them first.
- Keep Markdown simple: tables and admonitions (`!!! note`) are fine, no raw HTML.
- Use LF line endings (`.gitattributes` normalises text files to LF).
- Platform support statement: the local stdio server runs on macOS, Linux and
  Windows; the remote HTTP service is Linux-only (container image, refuses to
  start on Windows). Keep REMOTE.md, CONTAINERS.md and README.md consistent with it.

## Keep docs in sync with code

When the code below changes, update the matching doc in the same PR:

| Doc | Must match |
| --- | --- |
| `ERRORS.md` | the error catalog (every code, its recovery and `lookup_error`) |
| `MULTITENANT.md` | "Audited events" table, lifecycle events and the stderr JSON events (`audit_sink_unavailable`, `audit_sink_recovered`, `audit_record_rejected`, `audit_rotation_failed`) |
| `HEALTH.md` | `/livez`, `/readyz` and `get_service_health` readiness fields (`checks.*`, `limits.effective`); `REMOTE.md` repeats the `/readyz` summary, keep both in step |
| `REMOTE.md` | the env table: every `MD_*` variable read under `src/remote`, its default and meaning (`bun scripts/check-env-docs.ts` fails CI on a missing one) |
| `README.md` | the "Stdio environment variables" table: every `MD_*` name and `process.env` read in `src/*.ts` (same script, same CI failure) |
| `JWT.md` | revocation and expiry bounds (JWT TTL, 5 s `iat` skew, 60 s JWKS cache, 5 s refresh cooldown, 300 s upload grant, retention) |
| `CONTAINERS.md` | `Dockerfile.remote`, pinned versions, `docker-publish.yml` tags and secrets, compose files |

`bun scripts/check-env-docs.ts` enforces both env tables (remote in `REMOTE.md`, stdio in `README.md`) and prints one line per half; run it after touching either.

Also check `.env.*.example`, `QUICKSTART.md` and `/SKILL.md` when a variable or tool changes.

## Historical records

`MVP-VALIDATION.md` and `MULTITENANT-VALIDATION.md` record what was verified
at a point in time (commits, CI runs, environments). Do not rewrite their
results to match later code, and do not quote literal test or assertion
counts: the suites grow, and CI logs hold the current numbers.

## CI trigger caveat

`docs.yml` only runs on the paths in its `paths:` filter (docs, `mkdocs.yml`,
the hook, README/SKILL/PLAN, LICENSE, `examples/**`, `compose*.yaml`,
`.env*.example`, `Dockerfile.remote`, `scripts/**`, `src/remote/**`, and the
`docker-publish.yml`, `docs.yml` and `remote-mvp.yml` workflows). The build takes
under a minute, so remote code, scripts and CI changes run it too. Other
code-only changes (the stdio server in `src/`) do not, so for those also touch
the affected doc (or run the build locally) and keep the filter in sync with any
new repo file the docs link to.
