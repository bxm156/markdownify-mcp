# CLAUDE.md (src/remote/)

Remote Streamable HTTP MCP service: authenticated uploads, an on-disk job queue, markitdown conversion, paginated
Markdown. Operator docs: `docs/REMOTE.md`, `docs/MULTITENANT.md`, `docs/JWT.md`, `docs/HEALTH.md`, `docs/ERRORS.md`.
Built with `bun run build:remote` (tsc to `dist/remote/`), shipped as `Dockerfile.remote` and run by Node 22.

## Architecture

- `index.ts`: `startRemoteServer({ config, createJobs?, createServer?, processHandle?, log?, platform? })`. Deps are
  injectable so tests drive signals and exit without killing the runner. It refuses `win32`
  (`refuseUnsupportedPlatform`), warns if `MD_SHUTDOWN_TIMEOUT_MS > SHUTDOWN_TIMEOUT_WARN_MS` (15 000, the Compose
  `stop_grace_period`), runs `jobs.init()`, then listens. SIGINT/SIGTERM/SIGHUP run `shutdown`; its deadline closes
  every connection and calls `exit(1)`. `isEntryPoint()` uses `import.meta.main` or compares real paths, so importing
  the module never starts a server.
- `config.ts`: `loadConfig(env)` validates every `MD_*` variable (positive safe integers):
  - Auth, chosen by `auth.ts loadAuthenticator`: any `MD_JWT_*` key (even empty) selects JWT (`MD_JWT_ISSUER`,
    `_AUDIENCE`, `_JWKS_URL` are required; `_MAX_TTL_SECONDS` 1–3600, default 300; `_TOOL_PREFIX`;
    `_ALLOW_HTTP_LOCALHOST=1`, test only). Otherwise `MD_AUTH_FILE` (a hashed registry) or `MD_API_KEY` (32–4096
    chars, maps to `default/default`). Modes never combine. `MD_LEGACY_OWNER` gives ownerless manifests an owner.
  - Listener: `MD_HOST`, `MD_PORT`, `MD_PUBLIC_BASE_URL` (a bare origin), `MD_ALLOWED_HOSTS`, `MD_DATA_DIR`.
  - Limits: `MD_MAX_UPLOAD_BYTES`, `MD_MAX_OUTPUT_BYTES`, `MD_MAX_STORAGE_BYTES`, `MD_MAX_JOBS`, `MD_CONCURRENCY`,
    `MD_RETENTION_MS`, `MD_UPLOAD_TTL_MS`, `MD_CONVERSION_TIMEOUT_MS`, `MD_MAX_{TENANT,AGENT}_{JOBS,STORAGE_BYTES,CONCURRENCY}`.
  - `MD_SHUTDOWN_TIMEOUT_MS` (default 10 000). `MD_QUOTA_OVERRIDES_FILE` is read by `loadQuotaOverrides`: at most
    1 MiB, read through `O_NONBLOCK`, agent-scope caps only, never above the global caps.
- `http.ts`: routes `POST /mcp`, `PUT /uploads/<uuid>` and probes `/livez`, `/healthz` (liveness) and `/readyz`
  (`publicHealth()`, booleans only). It accepts only origin-form targets and rejects `//x`, `/\x`, absolute-form
  targets and any query (400). The Host allowlist and an `Origin` that must equal the public origin (403) do not
  apply to probes. Bodies: `/mcp` JSON at most 1 MiB (413); uploads are bounded by the declared size. Status codes:
  405 with `Allow` for a wrong method; 415 unless the content type is exactly `application/json` (lowercase) or
  `application/octet-stream`; 401 with `WWW-Authenticate: Bearer`. In JWT mode only, a request with no
  Authorization header may send `initialize`, `notifications/initialized` or `ping`, gated by readiness.
- `mcp.ts`: 7 tools: `get_service_health`, `create_upload`, `start_conversion`, `get_conversion_status`,
  `get_markdown`, `delete_job`, `lookup_error`. Schemas are `z.strictObject`. In JWT mode a call needs
  `mcp:tools/call` plus `mcp:tools/<name>:call` (or `<prefix><name>`), and a listing needs `mcp:tools/list`.
- `auth.ts` / `jwt.ts` / `identity.ts`: a principal is `{tenantId, agentId}` matching `[A-Za-z0-9_-]{1,64}`. Registry
  tokens are compared as SHA-256 hashes with `timingSafeEqual` over every entry. JWT accepts RS256 only with a pinned
  JWKS (256 KiB cap). Headers `jku`/`x5u`/`jwk`/`x5c`/`crit` are rejected before key lookup. `sub` is both tenant and
  agent, and `litellm-proxy` is refused. Upload grants (JWT mode) are a second random bearer, hashed per job. They
  last at most `min(MD_UPLOAD_TTL_MS, 300 s)`, are consumed by the PUT, and are checked by
  `JobService.authenticateUpload`.
- `jobs.ts`: `JobService`, one process per data directory. States go `awaiting_upload → uploaded → queued → running →
  completed|failed`. After expiry a job becomes `expired`, a tombstone with no files that is removed one retention
  later. Each job has `<id>/job.json`, `input.<ext>`, `output.md` and `output.md.index.json`. `init()` removes
  partials and orphan dirs and turns `running` into `failed`/`CONVERSION_INTERRUPTED`. Quotas reserve input plus
  `maxOutputBytes` and are checked per global, tenant and agent scope (including overrides). `pump()` schedules
  tenants and agents round-robin. Audit: `auditRead` coalesces `read_status`/`read_markdown` per (job, status) and
  samples re-reads by pass (`AUDIT_READ_REPEAT_EVERY`). `recoverAudit` probes with backoff (`AUDIT_PROBE_BASE_MS` →
  `AUDIT_PROBE_MAX_MS`, `AUDIT_PROBE_PASSES` passes). `cleanup()` is single-flight and isolates failures per job.
- `converter.ts`: `spawn`s the path from `resolveConverterExecutable` (no shell, stdout bounded). Abort reasons
  (`conversionAbort`, first one wins): `interrupted` → `CONVERSION_INTERRUPTED` (503), `timedOut` →
  `CONVERSION_TIMEOUT` (504, `details.timeout_ms`), `cancelled` → `CONVERSION_CANCELLED` (409). A killed child is
  never reported as `CONVERSION_FAILED`.
- `markdown.ts`: `readMarkdownPage` uses code-point offsets with a strict UTF-8 decoder. The index has a checkpoint
  every 4096 chars and is rebuilt if stale or malformed.
- `audit.ts`: `createAuditLogger(dir)` writes `audit.jsonl` (JSONL, explicit fields only). Rotation is resumable
  (4 MiB, `.1`..`.3`, it shifts into the lowest free slot). `AuditRecordError` means a bad record, not a bad sink.
  `probe()` opens for append without writing, then checks `statfs`.
- `health.ts`: `converterCandidates`/`resolveConverterExecutable`: an absolute or slashed path is used as is. A bare
  name is searched on `PATH` (`DEFAULT_PATH` when PATH is unset, empty entries skipped), and the file must be
  regular and `X_OK`. `checkRuntime` is single-flight, bounded by `HEALTH_TIMEOUT_MS`, and probes storage with
  `statfs` plus a `.health-<uuid>` file.
- `lock.ts`: `MD_DATA_DIR/.lock` (`pid`, token, `heartbeat=<ms>`) is created with `wx` and rewritten (temp + rename)
  every `HEARTBEAT_MS`. A lock whose mtime is older than `MD_LOCK_STALE_AFTER_MS` (`config.lockStaleAfterMs`, default
  60 000, 0 = never, else ≥ 15 000) is reclaimed: rename to a unique `.stale` name, verify inode and mtime, `wx`
  create. A heartbeat that finds a foreign token logs `lock_lost` and calls `onLost` (index.ts: shutdown, exit 1).
  Errors carry `reclaimHint` and `LOCK_REMOVAL_HINT`. `purge-owner.ts` is an operator CLI (`node dist/remote/purge-owner.js <dir>
  <tenant> <agent> [--apply]`, dry run by default). `--apply` holds the lock. Exit codes: 0 ok, 1 incomplete or
  refused, 2 usage.

## Error model (`errors.ts`)

- `ServiceError(status, message, code?, details?)`. The `catalog` maps each code to `{message, retryable, next_steps}`.
  `errorResponse` returns `{ error, error_info: {code, message, retryable, next_steps, details?} }` for both tool
  results (`isError: true`) and HTTP bodies. `lookupError` serves the same catalog to agents.
- Every client-visible failure needs a catalog code. Pass the code explicitly; the `legacyCode(message)` fallback
  exists for old manifests. Anything that is not a `ServiceError` becomes `INTERNAL_ERROR` "Operation failed".
- Never put paths, errno text, stack traces, parser stderr or other owners' usage or IDs in a message or `details`.
  `ErrorDetails` holds only numeric limits and `scope`.
- Stopped conversions: `INTERRUPTED` (shutdown or crash, retryable), `TIMEOUT` (deadline), `CANCELLED` (`delete_job`
  on a running job; the owner then sees `JOB_NOT_FOUND`). See "Stopped conversions" in `docs/ERRORS.md`.
- A foreign job and a missing job return the same 404 `JOB_NOT_FOUND`, plus an `authorization_denied` audit record.

## Operator stderr events

Single-line JSON (`console.error(JSON.stringify(...))`): `audit_sink_unavailable` {code}, `audit_sink_recovered`
{via: write|probe}, `audit_record_rejected` {message: fixed string}, `audit_rotation_failed` {code},
`shutdown_timeout_warning` {shutdown_timeout_ms, ceiling_ms}, `stale_lock_reclaimed` {age_ms}, `lock_lost` {},
`lock_heartbeat_failed` {code}. Cleanup logs a prefix plus an object, not JSON:
`Job cleanup failed {event: "job_cleanup_failed", job_id, status, code}` and `Job cleanup sweep incomplete
{event: "job_cleanup_sweep_failed", ...}`. Plain lines: `Job audit unavailable <event> <id>`, `Job cleanup sweep
failed`. Rule: an errno-style `code` (`/^[A-Z0-9_]{1,32}$/`, else `UNKNOWN`) and IDs only. Never paths, messages,
secrets, filenames or audit metadata values. Log once per transition, not once per failure.

## Invariants

- Linux only: no `win32` branches beyond the refusal (`WINDOWS_UNSUPPORTED_MESSAGE`, also in `purge-owner.ts`).
- Production code must run under Node 22 from `dist/`. No Bun-only APIs (`Bun.*`, `bun:*`) outside tests.
  `test-helpers.ts` and `*.test.ts` are excluded from the build.
- Writes: temp file plus `rename` (`job.json.<uuid>.tmp`, `*.index.json.<uuid>.tmp`, `input.part`/`output.part`) with
  files at `0o600` and dirs at `0o700`. `wx` for exclusive creates.
- Readiness writes no audit record and changes no job state. Its only filesystem effects are the `.health-*` probe
  and the audit probe's open-without-write.
- Audit fails closed: a failed caller-event write refuses the operation with 503 `AUDIT_UNAVAILABLE` and makes
  readiness false. The exceptions: coalesced or unsampled reads never touch the sink, and a lifecycle event
  (`*_completed`, `*_failed`, `job_expired`) that fails is logged without rolling back.
- The converter always spawns the absolute path that health resolved. If nothing resolves, that is ENOENT, which
  becomes `INTERNAL_ERROR`, and the service never falls back to its own search.
- The only outbound requests go to the pinned JWKS URL. Never add a fetch of a client-supplied URL. (DNS pinning,
  one lookup per connection, lives in the stdio `src/download.ts`.)
- One process per volume (`.lock`). Manifests are loaded only at `init()`.
- Keep docs in sync in the same change: audit events and stderr events → `docs/MULTITENANT.md` "Audited events";
  codes → `docs/ERRORS.md`; readiness fields → `docs/HEALTH.md`; `MD_*` → `docs/REMOTE.md` and `.env.*.example`;
  JWT bounds → `docs/JWT.md` (see `docs/CLAUDE.md`).

## Testing

- `bun test src/remote` (about 17–25 s; `bun run test:remote` is the same). `bun run typecheck` checks types.
- `test-helpers.ts`: `waitFor(predicate, {timeoutMs, intervalMs, label})` returns `Truthy<T>`. `closedPort()`,
  `mcpInitialize(base, auth)`, `toolJson`, `toolOk`, `toolErrorCode`. `createJwtFixture(...)` provides an RS256
  key, `sign`, `verifier`, `remoteVerifier`, `serveJwks`, and `deployment()` returning `{service, base, client, put}`.
  Call `close()` in `afterEach`.
- Fixtures: a `fs.mkdtemp(os.tmpdir())` data dir per service, removed in cleanup. Fake converters are functions
  that copy input to output, or `#!/bin/sh` scripts that write `$$` to a pid file and `exec sleep` (killed in
  dispose). Recording audit sinks (`recorder()` with a `fail` flag in `audit-policy.test.ts`) and `spyOn(console,
  "error")` for stderr events. `setSystemTime` drives TTL, retention and probe backoff.
- Slow tests that spawn real processes: `index.test.ts` runs `index.ts` as a child for signals and listen errors.
  `cleanup.test.ts` runs `bun run build:remote` and then the compiled `dist/remote/*.js` under `node` (skipped
  without node). `converter.test.ts`, `health-paths.test.ts`, `jobs-lifecycle.test.ts`, `provisioning.test.ts` and
  `quota.test.ts` spawn short-lived children.
- Rules: no fixed sleeps. Wait with `waitFor` for the state change and assert `error_info.code` and status (not
  message text). After writing a test, break the code under test and confirm the test fails, then restore it.

## Smoke scripts (built server; details in `scripts/CLAUDE.md`)

- `scripts/remote-http-smoke.ts`: against a running server (`MCP_URL`, `MCP_TOKEN`), runs init, discovery, PDF
  upload, conversion, paginated read and delete.
- `scripts/jwt-http-smoke.ts`: spawns `node dist/remote/index.js` in JWT mode with a local signer (optional real
  LiteLLM fixture).
- `scripts/multitenant-http-smoke.ts`: against a running registry-mode server (`MD_TEST_AGENT_KEYS` a, b, c), checks
  cross-agent isolation.
- `scripts/litellm-health-smoke.py`: compiled JWT-mode server plus LiteLLM 1.104's anonymous health client
  (`--self-test`).
