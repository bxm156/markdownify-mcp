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

Every value must be a positive safe integer. A reservation must fit global, tenant, and agent budgets. Even a tiny upload reserves the configured maximum output size, so storage limits can bind before job-count limits. Queue scheduling skips owners that have reached their concurrency cap, allowing another eligible owner to run; global concurrency still bounds total converters. These are admission and scheduling limits, not filesystem quotas or a distributed queue.

## Operations

New manifests persist immutable owner IDs. For a fresh deployment, leave `MD_LEGACY_OWNER` unset and use a new data volume. No client or data migration is required. The server retains an explicit recovery option for unowned manifests from older test deployments; assigning an owner is an operator-only operation and never happens automatically.

Audit records live in `MD_DATA_DIR/audit.jsonl`, with timestamps, tenant/agent IDs, job IDs, event/status codes, and limited reason codes. They exclude filenames, document content, and bearer/upload tokens. Rotation bounds local history to a 4 MiB active file and three archives. Export metadata to your logging system if longer retention is needed. Audit metadata itself identifies agents and should have restricted operator access.

This milestone supplies application-level file isolation for distinct credentials, bounded resources, and restart-safe ownership. The converter subprocess is not a security sandbox against malicious document parser exploits. Use trusted document sources or additional parser isolation for hostile uploads. Multiple service replicas, distributed storage/queues, and a credential-management UI remain separate work.

## Inspecting and purging a retired user's artifacts

Retention cleanup runs at startup and periodically. Once a job's `expires_at` passes (`MD_RETENTION_MS` after upload or completion, `MD_UPLOAD_TTL_MS` for an abandoned upload), it erases the input, `output.md` and its index, and leaves a metadata-only tombstone that is removed one retention period later. Running conversions are skipped until they finish. Each job is cleaned independently: a failure on one job is logged and retried on the next sweep while other jobs continue, and an overrunning sweep is never started twice. A job whose cleanup fails stays inaccessible to its owner (`Job expired`) and keeps its quota reservation until the tombstone is committed.

Operators see cleanup failures on stderr. Each sweep with failures logs one line per failed job, for example `Job cleanup failed { event: "job_cleanup_failed", job_id: "…", status: "completed", code: "EACCES" }`, and one summary line, `Job cleanup sweep incomplete { event: "job_cleanup_sweep_failed", jobs_failed, failures_total, consecutive_failed_sweeps, last_error_code, duration_ms }`. Neither contains paths, filenames, error messages or document contents. Alert on the `job_cleanup_sweep_failed` event. Agents see only their own jobs' cleanup state through `get_service_health` (see [HEALTH.md](HEALTH.md)), never service-wide totals.

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
| `.lock` | PID (informational only) plus a random per-acquisition token of the running service, or of a running `purge-owner --apply`; removed when that process exits, but left behind by SIGKILL, an OOM kill or a host crash, and never removed by a process whose lock was replaced by another one |

Stop the service before changing the volume. One process owns each data volume and loads every manifest only at startup, so edits under a running service race its in-memory state. The service creates `.lock` exclusively and refuses startup whenever that file exists, with `Data directory is in use: MD_DATA_DIR/.lock exists`. Graceful shutdown on SIGTERM, SIGINT or SIGHUP removes it, and so does every other process exit the runtime can observe: the forced exit when shutdown exceeds its 10-second deadline, an uncaught exception, or a startup failure. A SIGKILL (`docker kill`, or `docker stop` exceeding `stop_grace_period`), an OOM kill or a host crash leaves it behind, and every restart then fails with that message. With `restart: unless-stopped` the container then keeps restarting and failing, so stop it explicitly before removing the lock. A process only ever removes a lock whose contents (its PID plus a random per-start token) it wrote itself, so a hung old process cannot remove a newer service's lock. Automatic PID-based reclamation is unsafe because PIDs are reused and differ between container namespaces, so remove a leftover lock manually:

```sh
docker compose -f compose.multitenant.yaml stop markdownify   # also stops a crash-restart loop
docker compose -f compose.multitenant.yaml ps --all              # confirm no markdownify container is running or restarting
docker compose -f compose.multitenant.yaml run --rm --no-deps --entrypoint rm markdownify -f /data/.lock
docker compose -f compose.multitenant.yaml start markdownify
```

For a native process, stop it (and any supervisor that restarts it), confirm that it is not running, and run `rm -f "$MD_DATA_DIR/.lock"`. The purge tool refuses to run while any lock exists, and refuses a path that contains neither job manifests nor `audit.jsonl`. It follows a symlinked data directory and never reads document contents. It is a dry run unless `--apply` is given. A dry run reads manifests and file sizes only and writes nothing, so it also works on a read-only snapshot or mount. `--apply` needs write access and holds the lock for the whole run, so the service cannot start and load half-deleted directories during a purge. A completed purge, or one interrupted with SIGINT, SIGTERM or SIGHUP, leaves no lock; only SIGKILL (or an OOM kill or host crash) leaves one behind, to be removed as above:

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
