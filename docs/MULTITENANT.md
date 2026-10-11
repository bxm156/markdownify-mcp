# Multiple agents with isolated files

Each credential identifies one `(tenant_id, agent_id)` pair. A job is one uploaded file, its conversion lifecycle, and its generated Markdown. Both IDs must match before an agent can upload bytes, start conversion, check status, retrieve Markdown, or delete that job. Agents in the same tenant cannot share jobs. Tenants group resource budgets; they do not grant access to another agent's files.

Identity comes exclusively from the operator's credential registry. Tool arguments and caller-supplied tenant/agent headers cannot select an identity. Unknown IDs, wrong owners, and invalid upload tokens receive the same `Job not found` response. Invalid bearer credentials receive HTTP 401. There is no job-listing tool.

## Provision credentials

Create one long random bearer token for every agent. The provisioning utility stores a SHA-256 verifier in the registry and writes the raw token to a separate file for delivery to that agent's runtime. It does not print secrets:

```sh
bun scripts/create-agent-credential.ts tenant-a agent-a secrets/agents.json secrets/agent-a.token
bun scripts/create-agent-credential.ts tenant-a agent-b secrets/agents.json secrets/agent-b.token
bun scripts/create-agent-credential.ts tenant-b agent-a secrets/agents.json secrets/tenant-b-agent-a.token
```

Treat token files as secrets and deliver them through your secret manager. Keep the registry outside source control and image layers. The server needs only the registry, never the token files. Registry format:

```json
{
  "credentials": [
    {
      "tenant_id": "tenant-a",
      "agent_id": "agent-a",
      "token_sha256": "<64 hexadecimal characters from SHA-256 of the raw token>",
      "disabled": false
    }
  ]
}
```

The placeholder above is illustrative and is rejected by validation. IDs contain 1–64 ASCII letters, digits, underscores, or hyphens. Duplicate hashes, unknown fields, malformed entries, and an empty registry fail startup. Multiple distinct hashes may identify the same principal for credential rotation; those credentials intentionally access the same agent's files. Assign different `agent_id` values when file isolation is required.

Set `MD_AUTH_FILE` to the registry path. Remove `MD_API_KEY` entirely from the process environment; an empty `MD_API_KEY` still counts as set, and combining the two modes fails startup. Registry changes are loaded on process startup. Restart after adding, disabling, or removing a credential. To rotate, add a new verifier for the same principal, restart, update the agent runtime, remove or disable the old verifier, then restart again. Existing job ownership survives rotation. A revoked credential cannot use a previously issued upload token because every PUT also needs an active bearer credential for the owner.

`MD_API_KEY` remains a compatibility mode mapping all holders to the single `default/default` agent. It cannot isolate multiple agents.

## Start the service

For a native process, set `MD_AUTH_FILE` and the listener/storage settings described in [REMOTE.md](REMOTE.md), then run `node dist/remote/index.js`. The entry point does not automatically load environment files.

For Docker, use the standalone Compose configuration:

```sh
cp .env.multitenant.example .env.multitenant
# Edit public origin and limits. Provision secrets/agents.json first.
docker compose -f compose.multitenant.yaml up --build -d
```

Compose mounts only `secrets/agents.json` read-only at `/run/markdownify/agents.json`. It does not mount raw agent token files. The service runs as UID/GID 10001. On a Linux host, ensure that this UID or group can read the registry; for example, grant group 10001 read access with `chgrp 10001 secrets/agents.json` and `chmod 640 secrets/agents.json`. Keep its parent directories traversable by the container process. Windows Docker Desktop bind mounts use host-specific permission behavior. A missing or unreadable registry fails startup.

The provisioning utility atomically replaces the registry and resets its mode to 600. After each update, reapply any required Linux group permissions and recreate the container with `docker compose -f compose.multitenant.yaml up -d --force-recreate`. Recreating ensures the file bind mount reads the replacement registry. Native processes only require a restart.

Use this Compose file by itself, rather than merging it with `compose.remote.yaml`, whose environment file selects legacy-key mode. Both configurations use the same named data volume within the same Compose project. Run one process/replica per volume. Set the public HTTPS origin and configure the proxy to preserve `Authorization` and `X-Upload-Token`, route `/mcp` and `/uploads/*`, and allow PUT. Existing host/origin checks still apply.

## Upload protocol

`create_upload` returns `required_headers` containing `X-Upload-Token` and `Content-Type`. The agent runtime adds its own `Authorization: Bearer <agent credential>` when streaming the file to the direct upload origin. The server never echoes the long-lived bearer credential in tool results. Upload tokens remain short-lived, scoped to one owner and one upload, and are invalidated after successful upload.

All new clients use the agent credential in `Authorization` and the scoped token in `X-Upload-Token`. The repository's runtime example implements this protocol:

```sh
# Direct MCP connection; load this agent's token securely.
export MCP_URL=https://markdownify.example.com/mcp
export MCP_TOKEN='<agent bearer token>'
bun examples/upload-and-convert.ts ./report.docx ./report.md
```

## LiteLLM identity forwarding

Each agent must forward its own Markdownify credential on every MCP request. A shared static upstream credential would make every request identify as the same agent and defeat isolation. Configure the LiteLLM server alias without static upstream authentication:

```yaml
mcp_servers:
  markdownify:
    url: https://markdownify.example.com/mcp
    transport: http
    auth_type: none
```

The agent's MCP client sends both `x-litellm-api-key: Bearer <agent virtual key>` for the gateway and `x-mcp-markdownify-authorization: Bearer <agent Markdownify credential>` for the upstream server. The alias in the forwarding header must match `markdownify` in the configuration. Grant that virtual key access to this MCP server. Tool names may be prefixed; discover them from the gateway.

For the repository example:

```sh
export MCP_URL=https://litellm.example.com/markdownify/mcp
export LITELLM_API_KEY='<agent LiteLLM virtual key>'
export MARKDOWNIFY_AGENT_TOKEN='<agent Markdownify bearer token>'
export MARKDOWNIFY_BASE_URL=https://markdownify.example.com
bun examples/upload-and-convert.ts ./report.pdf ./report.md
```

Binary uploads bypass LiteLLM and go to the configured direct origin with the same agent credential plus scoped upload token. Provisioning keys and any LiteLLM header allowlist are operator responsibilities. Verify forwarding with two distinct agents before enabling access. See the [LiteLLM MCP configuration reference](https://docs.litellm.ai/docs/mcp_config_reference). Automated isolation tests exercise the native server; live LiteLLM deployment remains an environment-specific check.

### Stored per-user credentials in LiteLLM

The header above is LiteLLM's per-request credential override: the gateway stores nothing and the client supplies the Markdownify token on every call. LiteLLM can also hold that token for the user. Mark the `markdownify` server as BYOK ("bring your own key") in the LiteLLM Admin UI or REST API (not `config.yaml`), then each user stores their Markdownify credential once with `POST /v1/mcp/server/{server_id}/user-credential`. LiteLLM attaches it to that user's calls. A user without a stored credential receives 401 with a `byok_auth_required` error and a `WWW-Authenticate` header pointing at LiteLLM's authorization page.

Stored credentials are keyed by LiteLLM `user_id` and server, not by virtual key. Two virtual keys with the same `user_id` share one Markdownify credential and therefore one Markdownify agent identity; give each service account its own machine user. A virtual key without a `user_id` cannot store a credential (`400 User ID not found in token`) and must use the per-request header instead. Markdownify sees only the forwarded bearer, so isolation, quotas and audit identity come from the registry entry it matches, never from LiteLLM's user ID.

Per-user OAuth and LiteLLM's DCR bridge do not apply: Markdownify is not an OAuth 2.0 resource or authorization server. Binary uploads still bypass LiteLLM and need the same agent credential plus the scoped upload token. See [LiteLLM per-user MCP authentication](https://docs.litellm.ai/docs/mcp_per_user_auth).

### Registry forwarding or JWT mode

Registry mode with forwarded or stored credentials proves the caller holds a Markdownify secret. [JWT mode](JWT.md) proves the request was signed by your LiteLLM for a specific user, with per-tool scopes and short-lived tokens. Choose registry forwarding when the gateway cannot run the `mcp_jwt_signer` guardrail, when immediate revocation matters more than token lifetime (set `disabled: true` on the registry entry and restart; issued JWTs stay valid until they expire), or when some agents call Markdownify without LiteLLM. Choose JWT mode when only gateway-originated traffic should be accepted and per-user provisioning should live entirely in LiteLLM. The modes are exclusive per deployment. With forwarding, anyone holding a Markdownify token can call the server directly, so restrict network access to the gateway where that matters.

## Budgets and scheduling

Global limits from [REMOTE.md](REMOTE.md) still apply. The following additional limits are independently enforced:

| Variable | Default | Scope |
| --- | --- | --- |
| `MD_MAX_TENANT_JOBS` | 25 | Live jobs across all agents in one tenant |
| `MD_MAX_TENANT_STORAGE_BYTES` | 134,217,728 (128 MiB) | Input plus maximum-output reservations for one tenant |
| `MD_MAX_TENANT_CONCURRENCY` | 1 | Active conversions across one tenant |
| `MD_MAX_AGENT_JOBS` | 10 | Live jobs for one agent |
| `MD_MAX_AGENT_STORAGE_BYTES` | 134,217,728 (128 MiB) | Input plus maximum-output reservations for one agent |
| `MD_MAX_AGENT_CONCURRENCY` | 1 | Active conversions for one agent |
| `MD_QUOTA_OVERRIDES_FILE` | unset | Optional per-principal agent caps; see [operator quota overrides](#operator-quota-overrides) |

Every value must be a positive safe integer. They get the same startup checks as [override entries](#operator-quota-overrides): a value set above its global cap (`MD_MAX_JOBS`, `MD_MAX_STORAGE_BYTES`, `MD_CONCURRENCY`) is rejected, and every storage budget, global, tenant and agent, must be at least `1 + MD_MAX_OUTPUT_BYTES`, or no upload could ever be admitted. An unset tenant or agent cap is lowered to its global cap instead of rejected, since the tightest scope applies anyway; an unset storage default that is still below the floor (for example with a 200 MiB `MD_MAX_OUTPUT_BYTES`) stops startup and names the variable to set. A reservation must fit global, tenant, and agent budgets. Even a tiny upload reserves the configured maximum output size, so storage limits can bind before job-count limits. Queue scheduling skips owners that have reached their concurrency cap, allowing another eligible owner to run; global concurrency still bounds total converters. These are admission and scheduling limits, not filesystem quotas or a distributed queue.

In [JWT mode](JWT.md#effective-per-user-limits) the tenant and agent ID are both the LiteLLM user ID, so one user is bound by both scopes and the effective cap is the minimum of the global, tenant and agent limits. `get_service_health` reports that minimum for the caller as `limits.effective`.

### Operator quota overrides

Operators can give specific principals different agent-scope caps with a JSON file named by `MD_QUOTA_OVERRIDES_FILE`. Because tenant caps still apply, raising an agent above a tenant default only takes effect if the tenant cap is raised too. This example raises two tenant caps and keeps every other setting at its default:

```dotenv
MD_MAX_TENANT_JOBS=40
MD_MAX_TENANT_CONCURRENCY=2
MD_QUOTA_OVERRIDES_FILE=/run/markdownify/quota-overrides.json
```

```json
{
  "overrides": [
    { "tenant_id": "tenant-a", "agent_id": "batch-agent", "max_jobs": 40, "max_concurrency": 2 },
    { "tenant_id": "markdownify-agent-b", "agent_id": "markdownify-agent-b", "max_jobs": 2, "max_storage_bytes": 67108864 }
  ]
}
```

`get_service_health` then reports these `limits.effective` values:

| Caller | `jobs` | `reserved_bytes` | `concurrency` |
| --- | --- | --- | --- |
| `tenant-a` / `batch-agent` (raised) | 40 | 134,217,728 (128 MiB) | 2 |
| `markdownify-agent-b` (lowered) | 2 | 67,108,864 (64 MiB) | 1 |
| Any unlisted principal | 10 | 134,217,728 (128 MiB) | 1 |

Unlisted agents are still held to `MD_MAX_AGENT_JOBS=10` and `MD_MAX_AGENT_CONCURRENCY=1`. In this example the storage budget binds before the job counts. Every job reserves its input plus `MD_MAX_OUTPUT_BYTES` (25 MiB by default), so the 128 MiB tenant budget holds at most five live jobs for all of `tenant-a` together, and the 64 MiB override holds two. The example's practical effect for `batch-agent` is therefore the second converter slot, not 40 live jobs. To let it hold more jobs, also raise `MD_MAX_TENANT_STORAGE_BYTES` (and `MD_MAX_STORAGE_BYTES` if needed) and its `max_storage_bytes`, or lower `MD_MAX_OUTPUT_BYTES`. With the default `MD_CONCURRENCY=2`, `batch-agent` can occupy both global converter slots, and round-robin scheduling hands each freed slot to other waiting tenants in turn.

Each entry replaces the `MD_MAX_AGENT_JOBS`, `MD_MAX_AGENT_STORAGE_BYTES` and/or `MD_MAX_AGENT_CONCURRENCY` defaults for exactly that `(tenant_id, agent_id)` pair; omitted fields keep the default. An override may lower or raise a cap. Global and tenant caps still apply, so the effective cap is the minimum of the global, tenant and agent values. In JWT mode, use the LiteLLM user ID as both `tenant_id` and `agent_id`. Because the tenant limits bind that same user ([effective per-user limits](JWT.md#effective-per-user-limits)), raising a user above the `MD_MAX_TENANT_*` defaults requires raising those too.

This is not an allowlist. Principals that are not listed keep the configured defaults, and an entry never grants or denies access to files or tools. Identity still comes only from the authenticator; a quota entry does not provision credentials or LiteLLM users.

The file is read once at startup and validated strictly. Startup fails with an `MD_QUOTA_OVERRIDES_FILE` error if the file is missing, not a regular file, larger than 1 MiB or not JSON; if the top level has keys other than `overrides`; or if an entry has an invalid or duplicate principal, an unknown field, no limit field, or a limit that is not a positive safe integer. A limit above the matching global cap (`MD_MAX_JOBS`, `MD_MAX_STORAGE_BYTES` or `MD_CONCURRENCY`) is rejected rather than silently clamped. Because every job reserves its input plus `MD_MAX_OUTPUT_BYTES`, a `max_storage_bytes` below `MD_MAX_OUTPUT_BYTES + 1` could never admit an upload and is also rejected. Restart the service after editing the file. In Docker, mount the file read-only and readable by UID/GID 10001, as for the credential registry.

Agents cannot change quotas. No tool accepts tenant, agent or quota arguments. `get_service_health` shows each caller only its own job states, `own_reserved_bytes` and `limits`: `agent_*` include that caller's override, `agent_override` says whether one applies, and `limits.effective` gives the tightest `jobs`, `reserved_bytes` and `concurrency` that admission and scheduling enforce. It never reveals other principals' overrides, usage or IDs. Quota errors keep the existing `JOB_LIMIT_EXCEEDED` and `STORAGE_LIMIT_EXCEEDED` codes; with `scope: "agent"`, `limit_jobs` or `limit_bytes` is the overridden value.

Reservations count input bytes plus the maximum output size for every non-expired job, including queued and running work. Deleting a job releases its reservation immediately; an expired job releases it when periodic cleanup marks it expired, within a minute of its expiry time, unless cleanup of that job keeps failing. They are admission limits, not a filesystem hard quota: manifests, indexes and audit logs add overhead outside the budget.

## Operations

New manifests persist immutable owner IDs. For a fresh deployment, leave `MD_LEGACY_OWNER` unset and use a new data volume. No client or data migration is required. The server retains an explicit recovery option for unowned manifests from older test deployments; assigning an owner is an operator-only operation and never happens automatically.

Audit records live in `MD_DATA_DIR/audit.jsonl`, with timestamps, tenant/agent IDs, job IDs, event/status codes, and limited reason codes. They exclude filenames, document content, and bearer/upload tokens. Rotation bounds local history to a 4 MiB active file and three archives (`audit.jsonl.1` newest to `.3` oldest); no more files are ever kept. Rotation is resumable: if a step fails (for example a rename returns `EBUSY`), the triggering record is refused and the next write completes the interrupted shift into the free slot instead of starting over, and the oldest archive is deleted only when all three exist, so a failed rotation never drops a generation early. Export metadata to your logging system if longer retention is needed. Audit metadata itself identifies agents and should have restricted operator access.

### Audited events

Each record's `status` is the job's state when the event happened. Events written on behalf of a caller are written before the operation runs; if that write fails, the operation is refused with `AUDIT_UNAVAILABLE` (HTTP 503) and nothing changes:

| Event | When | Fields besides tenant/agent |
| --- | --- | --- |
| `create_upload` | `create_upload` passed admission | none |
| `quota_denied` | `create_upload` refused by a job or storage cap | `reason: capacity_exhausted` |
| `authorization_denied` | Any job operation or upload PUT on a job ID the caller does not own or that does not exist, or a wrong upload token | `job_id` (when UUID-shaped), `reason: job_not_found` |
| `upload` | Upload PUT accepted, before bytes are read | `job_id`, `status` |
| `start_conversion` | Every `start_conversion` call on an unexpired job, including idempotent repeats | `job_id`, `status` |
| `read_status` | `get_conversion_status`, coalesced (below) | `job_id`, `status` |
| `read_markdown` | `get_markdown`, coalesced (below) | `job_id`, `status` |
| `read_markdown_repeat` | Every 10th read pass over a completed result; paging forward within a pass does not count (below) | `job_id`, `status: completed`, `repeat_count` (the pass number) |
| `delete_job` | `delete_job`, before work is cancelled and files are removed | `job_id` |

Lifecycle events are written after the state change has been committed. A failed write is logged to stderr as a `job_audit_unavailable` [operator event](#operator-stderr-events) with the event and job ID and does not roll the change back:

| Event | When |
| --- | --- |
| `create_upload_completed` | The upload reservation was saved |
| `upload_completed` / `upload_failed` | An upload finished or was rejected (size mismatch, timeout, disconnect) |
| `conversion_completed` / `conversion_failed` | A conversion finished |
| `job_expired` | Retention cleanup erased a job's files and left a tombstone |

`get_service_health`, `lookup_error`, `tools/list`, `/livez`, `/readyz`, anonymous `initialize`/`ping` and rejected credentials (HTTP 401) are not audited.

`read_status` and `read_markdown` are coalesced because agents poll status with backoff and read Markdown page by page. Each is recorded once per job for each job state the owner observes. A poll loop therefore writes at most one `read_status` record per state (for example `awaiting_upload`, `uploaded`, `queued`, `running`, `completed`), and retrieving every page of a completed result writes one `read_markdown` record. Re-reading a completed result is sampled rather than hidden, and it is counted in read passes, not pages. The first `get_markdown` of a completed result starts pass 1, and the service remembers the `offset` each read requested. A read whose `offset` is greater than the previous read's continues the current pass; any other read (back to offset 0, back to a lower offset, or the same offset again) starts the next pass. Every 10th pass writes a `read_markdown_repeat` record whose `repeat_count` is the pass number (10, 20, 30, ...). Reading a 25-page result from start to end is therefore one pass, and heavy re-reading is visible at one record per ten passes however long the document is. Status polling is not sampled, and reads of a job that is not yet completed stay coalesced. A read whose audit write failed is not counted as recorded, so the owner's retry writes it. A coalesced or unsampled read does not touch the audit sink, so it succeeds even while the sink is failing; the first read of a new state and the read that starts every 10th pass still fail closed, and that read's retry starts the same pass again. The record of what has been seen (the states observed, the pass number and the last requested offset) is kept in memory per job and dropped when the job is deleted or its tombstone is removed, so it is bounded by the job limits. It is also per process: after a restart, or on another replica serving the same job, the first read of each state is recorded again and pass counts start again from pass 1, so count reads per job across `read_markdown` and `read_markdown_repeat` records, not from `repeat_count` alone. `authorization_denied`, `quota_denied` and every mutation or lifecycle event are never coalesced or sampled: repeated denied attempts each write a record.

Readiness reports the audit sink. After a failed audit write, from a caller's operation or a lifecycle event, `checks.audit.available` is `false` and `/readyz` returns 503 until a write succeeds. Because a replica removed from service by its readiness probe gets no traffic to write with, readiness also runs a recovery probe while the sink is failing: it opens `audit.jsonl` for append without writing anything, then requires free space on its filesystem. The probe is shared by concurrent health checks and bounded by the five-second health timeout. It cannot see failures that only occur when bytes are written (EIO, filesystem quotas), so a sink that passes it but fails real writes would otherwise flip readiness back and forth. To damp that, the first probe after a failure runs at once, the wait after each probe starts at 2 seconds and doubles up to 60 seconds, and `available` returns only after 2 consecutive passing probes with no failed write in between. The backoff is kept when a write fails again after a probe-based recovery, so a flapping sink is probed less and less often; a successful audit write restores readiness immediately and resets the backoff. Health checks never write audit records. See [HEALTH.md](HEALTH.md).

A record the audit logger rejects before touching storage (for example `Invalid audit metadata`, which indicates a bug, not a disk problem) still refuses the operation with `AUDIT_UNAVAILABLE`, but does not mark the sink unavailable or affect readiness. Each distinct rejection message is logged once.

### Operator stderr events

Every operator event is one line of JSON on stderr (one object per line, always with an `event` field), so a log pipeline can parse and alert on it. Events carry no paths, filenames, error messages, secrets, document contents or audit metadata values. A `code` is an errno-style code (`EIO`, `ENOSPC`, `EACCES`, ...) or `UNKNOWN`. The startup line `Markdownify remote listening on <host>:<port>` and fatal startup errors are plain text.

| Event | When | Fields besides `event` |
| --- | --- | --- |
| `audit_sink_unavailable` | The first failed write after the sink was available (not repeated per failed write or probe) | `code` |
| `audit_sink_recovered` | The sink became available again | `via`: `write` (a write succeeded) or `probe` (two consecutive probes passed) |
| `audit_record_rejected` | The logger rejected a record before writing; once per distinct message per process | `message`: a fixed string such as `Invalid audit metadata` |
| `audit_rotation_failed` | A step of log rotation failed, so the triggering record was refused; once until a rotation succeeds | `code`: errno-style code such as `EBUSY`, `EACCES`, or `UNKNOWN` |
| `job_audit_unavailable` | A lifecycle event's audit write failed after its change committed (the change stands; `audit_sink_unavailable` reports the sink) | `audit_event` (for example `job_expired`), `job_id` |
| `job_cleanup_failed` | Retention cleanup failed for one job; once per failed job per sweep | `job_id`, `status` (the job's committed state), `code` |
| `job_cleanup_sweep_failed` | A sweep finished with at least one failed job; once per such sweep. Alert on this one | `jobs_failed`, `failures_total`, `consecutive_failed_sweeps`, `last_error_code`, `duration_ms` |
| `job_cleanup_sweep_aborted` | A periodic sweep failed as a whole rather than per job | `code` |
| `shutdown_timeout_warning` | At startup, when `MD_SHUTDOWN_TIMEOUT_MS` exceeds the 15 s Compose `stop_grace_period` | `shutdown_timeout_ms`, `ceiling_ms` |
| `stale_lock_reclaimed` | Startup (or `purge-owner --apply`) replaced a `.lock` left by a holder that stopped refreshing it (see [the lock](#the-data-volume-lock)); once per reclaim | `age_ms`: how long the lock file had not been modified |
| `lock_lost` | A heartbeat found that `.lock` no longer carries this process's token (another process reclaimed it, or it was removed). The server then shuts down as on SIGTERM and exits 1; `purge-owner --apply` stops and exits 1. Neither removes the file | none |
| `lock_heartbeat_failed` | A heartbeat could not read or rewrite `.lock`; once until a heartbeat succeeds. If it keeps failing for `MD_LOCK_STALE_AFTER_MS`, another process may reclaim the lock | `code`: errno-style code such as `EIO`, `EROFS`, or `UNKNOWN` |

This milestone supplies application-level file isolation for distinct credentials, bounded resources, and restart-safe ownership. The converter subprocess is not a security sandbox against malicious document parser exploits. Use trusted document sources or additional parser isolation for hostile uploads. Multiple service replicas, distributed storage/queues, and a credential-management UI remain separate work.

## Inspecting and purging a retired user's artifacts

Retention cleanup runs at startup and periodically. Once a job's `expires_at` passes (`MD_RETENTION_MS` after upload or completion, `MD_UPLOAD_TTL_MS` for an abandoned upload), it erases the input, `output.md` and its index, and leaves a metadata-only tombstone that is removed one retention period later. Running conversions are skipped until they finish. Each job is cleaned independently: a failure on one job is logged and retried on the next sweep while other jobs continue, and an overrunning sweep is never started twice. A job whose cleanup fails stays inaccessible to its owner (`Job expired`) and keeps its quota reservation until the tombstone is committed.

Operators see cleanup failures on stderr as [operator events](#operator-stderr-events). Each sweep with failures logs one line per failed job, for example `{"event":"job_cleanup_failed","job_id":"…","status":"completed","code":"EACCES"}`, and one summary line, `{"event":"job_cleanup_sweep_failed","jobs_failed":1,"failures_total":3,"consecutive_failed_sweeps":2,"last_error_code":"EACCES","duration_ms":4}`. Neither contains paths, filenames, error messages or document contents. Alert on the `job_cleanup_sweep_failed` event. Agents see only their own jobs' cleanup state through `get_service_health` (see [HEALTH.md](HEALTH.md)), never service-wide totals.

A common cause is a volume restored or copied with the wrong owner. The Compose service runs as UID/GID 10001 with all capabilities dropped, so it cannot repair ownership itself, and neither can the purge tool below when run the same way. Fix it once as root with the service stopped:

```sh
docker compose -f compose.multitenant.yaml stop markdownify
docker compose -f compose.multitenant.yaml run --rm --no-deps --user 0:0 --cap-add CHOWN --cap-add DAC_OVERRIDE --entrypoint chown markdownify -R 10001:10001 /data
docker compose -f compose.multitenant.yaml start markdownify
```

For a native process, run `chown -R` as root to the account that runs the service.

When a user's LiteLLM access or credential is revoked, their agent can no longer call `delete_job`, and no agent can list or delete another agent's jobs. Their files still expire on the schedule above. To remove them sooner, or when cleanup keeps failing, use privileged operator access to the data volume. This maintenance path is separate from agent access: never expose it through MCP, LiteLLM or an agent credential. Revoke the credential first (registry or JWT signer) so no new jobs appear.

The data volume contains:

| Path under `MD_DATA_DIR` | Contents |
| --- | --- |
| `<job-id>/job.json` | Manifest: `id`, `tenant_id`, `agent_id`, `status`, `filename`, `created_at`, `expires_at`; salted upload-token hashes only until the upload completes |
| `<job-id>/input.<ext>` | Uploaded document |
| `<job-id>/output.md`, `<job-id>/output.md.index.json` | Converted Markdown and its pagination index |
| `<job-id>/input.part`, `output.part`, `job.json.<uuid>.tmp` | Crash partials; removed at startup |
| `audit.jsonl`, `audit.jsonl.1`–`.3` | Metadata-only audit history shared by all agents |
| `.lock` | PID (informational only), a random per-acquisition token and the last heartbeat time of the running service, or of a running `purge-owner --apply`; refreshed every 5 seconds and removed when that process exits. Left behind by SIGKILL, an OOM kill or a host crash until it is reclaimed as stale; never removed by a process whose lock was replaced by another one |
| `.lock.<uuid>.tmp`, `.lock.<uuid>.stale` | Transient files of a heartbeat rewrite or a stale-lock reclaim |

### The data volume lock

Stop the service before changing the volume. One process owns each data volume and loads every manifest only at startup, so edits under a running service race its in-memory state. The service creates `.lock` exclusively, and startup fails with `Data directory is in use: MD_DATA_DIR/.lock exists` while another live process holds it. Graceful shutdown on SIGTERM, SIGINT or SIGHUP removes it, and so does every other process exit the runtime can observe: the forced exit when shutdown exceeds its deadline (`MD_SHUTDOWN_TIMEOUT_MS`, default 10 seconds), an uncaught exception, or a startup failure. A process only ever removes a lock that still carries its own random per-start token, so a hung old process cannot remove a newer service's lock.

A SIGKILL (`docker kill`, or `docker stop` exceeding `stop_grace_period`), an OOM kill or a host crash cannot remove the file. PIDs are reused and differ between container namespaces, so ownership is never judged by PID. Instead the holder refreshes the lock every 5 seconds (a heartbeat: it rewrites the file through a temporary file and a rename, which also updates its modification time), and startup treats a lock whose file has not been modified for longer than `MD_LOCK_STALE_AFTER_MS` (default 60,000 ms, at least 15,000) as left by a dead process. It reclaims it, logs one `{"event":"stale_lock_reclaimed","age_ms":N}` line and starts normally. The age comes from the file's modification time on the volume, never from the heartbeat value written inside it, so a previous host with a skewed clock cannot make a dead lock look fresh. Until the threshold passes, startup fails and the error says when the lock will be reclaimed; with `restart: unless-stopped` the container therefore restarts a few times and then recovers on its own, with the job that was running recovered as `CONVERSION_INTERRUPTED`.

Reclaim is safe against two processes starting at once: a contender first renames the stale file to a unique name, which only one process can do with that file, and checks that it moved the very file it judged stale (same inode and modification time) before creating its own lock exclusively. A contender that lost the race restores the winner's lock and fails like any other refused start. Every heartbeat also re-reads the file (fencing): if the token is no longer its own, for example because a paused process was presumed dead and its lock reclaimed, the process logs `{"event":"lock_lost"}`, shuts down as on SIGTERM (running conversions are interrupted) and exits 1 without removing anything. Reclaim relies on the modification time advancing on the shared volume, so keep the default on local and Docker volumes; on a network filesystem whose clock is unreliable, or anywhere two hosts might mount the same volume, set `MD_LOCK_STALE_AFTER_MS=0`.

`MD_LOCK_STALE_AFTER_MS=0` disables reclaim and restores the manual procedure: every restart after a crash fails until an operator removes the lock. With `restart: unless-stopped` the container keeps restarting and failing, so stop it explicitly before removing the lock:

```sh
docker compose -f compose.multitenant.yaml stop markdownify   # also stops a crash-restart loop
docker compose -f compose.multitenant.yaml ps --all              # confirm no markdownify container is running or restarting
docker compose -f compose.multitenant.yaml run --rm --no-deps --entrypoint rm markdownify -f /data/.lock
docker compose -f compose.multitenant.yaml start markdownify
```

For a native process, stop it (and any supervisor that restarts it), confirm that it is not running, and run `rm -f "$MD_DATA_DIR/.lock"`.

### Purging an owner's jobs

A purge dry run refuses to run while any lock exists, and refuses a path that contains neither job manifests nor `audit.jsonl`. It follows a symlinked data directory and never reads document contents. It is a dry run unless `--apply` is given. A dry run reads manifests and file sizes only and writes nothing, so it also works on a read-only snapshot or mount. `--apply` needs write access and holds the lock for the whole run, heartbeating like the service, so the service cannot start and load half-deleted directories during a purge. It reads `MD_LOCK_STALE_AFTER_MS` too (the Compose commands below inherit it from the env file), so it reclaims a stale crash leftover the same way; if it loses the lock mid-run it stops before the next deletion, prints `Purge aborted: another process took over MD_DATA_DIR/.lock ...` and exits 1. A completed purge, or one interrupted with SIGINT, SIGTERM or SIGHUP, leaves no lock; only SIGKILL (or an OOM kill or host crash) leaves one behind, reclaimed or removed as above:

```sh
docker compose -f compose.multitenant.yaml stop markdownify
# Dry run: lists the owner's job IDs, states and byte counts, plus skipped and unreadable directories.
docker compose -f compose.multitenant.yaml run --rm --no-deps markdownify node dist/remote/purge-owner.js /data <tenant_id> <agent_id>
# After reviewing the list, remove those job directories.
docker compose -f compose.multitenant.yaml run --rm --no-deps markdownify node dist/remote/purge-owner.js /data <tenant_id> <agent_id> --apply
# Confirm before restarting (the running service holds the lock, so purge-owner refuses afterwards): "jobs" must be empty.
docker compose -f compose.multitenant.yaml run --rm --no-deps markdownify node dist/remote/purge-owner.js /data <tenant_id> <agent_id>
docker compose -f compose.multitenant.yaml start markdownify
```

For a native process, run `node dist/remote/purge-owner.js "$MD_DATA_DIR" <tenant_id> <agent_id> [--apply]` with the process stopped, and repeat the dry run before restarting it. The tool always prints a JSON report:

- `jobs`: the owner's jobs, each `listed` (dry run), `deleted`, or `failed` with an errno-style `code`. A failure on one job does not stop the others.
- `skipped`: directories it will not touch: `missing_manifest` (an interrupted create, removed by the service at startup), `legacy_unowned` (a manifest without owner fields, only usable with `MD_LEGACY_OWNER`), `malformed_owner` (a manifest with only one of `tenant_id`/`agent_id`, or a non-string value), and `id_mismatch` (a manifest whose `id` differs from its directory name). Startup refuses `malformed_owner` and `id_mismatch`, and `legacy_unowned` unless `MD_LEGACY_OWNER` is set, so inspect them manually.
- `unreadable`: manifests that could not be read or parsed. Ownership is never guessed; startup refuses these too.

The exit status is 0 only when no job failed and no manifest was unreadable, 1 otherwise or when a precondition fails, and 2 for usage errors. Rerun with `--apply` after fixing a failure; already deleted jobs are simply absent. Do not delete job directories by hand from manifest contents: a directory's name, not the manifest's `id` field, is what the service loads.

Audit entries for the retired agent contain only IDs and event codes and rotate out of the bounded history; export or filter `audit.jsonl` according to your own retention policy while the service is stopped. After the confirming dry run lists no jobs, restart the service and check that no `job_cleanup_sweep_failed` line follows the next sweep.

## Verification

```sh
bun run build:remote
bun test src/remote
bun scripts/remote-converter-smoke.ts
# Use the environment and invocation documented in the validation report.
```

Tests cover same-tenant/different-agent isolation, cross-tenant isolation, forged identities, scoped upload tokens, rotation/revocation, ownership after restart, explicit legacy migration, quota accounting, and scheduler caps. Run the HTTP smoke check for each deployment and verify that another agent cannot retrieve or delete its results.
