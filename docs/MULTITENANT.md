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

In [JWT mode](JWT.md#effective-per-user-limits) the tenant and agent ID are both the LiteLLM user ID, so one user is bound by both scopes and the effective cap is the minimum of the global, tenant and agent limits.

## Operations

New manifests persist immutable owner IDs. For a fresh deployment, leave `MD_LEGACY_OWNER` unset and use a new data volume. No client or data migration is required. The server retains an explicit recovery option for unowned manifests from older test deployments; assigning an owner is an operator-only operation and never happens automatically.

Audit records live in `MD_DATA_DIR/audit.jsonl`, with timestamps, tenant/agent IDs, job IDs, event/status codes, and limited reason codes. They exclude filenames, document content, and bearer/upload tokens. Rotation bounds local history to a 4 MiB active file and three archives. Export metadata to your logging system if longer retention is needed. Audit metadata itself identifies agents and should have restricted operator access.

This milestone supplies application-level file isolation for distinct credentials, bounded resources, and restart-safe ownership. The converter subprocess is not a security sandbox against malicious document parser exploits. Use trusted document sources or additional parser isolation for hostile uploads. Multiple service replicas, distributed storage/queues, and a credential-management UI remain separate work.

## Verification

```sh
bun run build:remote
bun test src/remote
bun scripts/remote-converter-smoke.ts
# Use the environment and invocation documented in the validation report.
```

Tests cover same-tenant/different-agent isolation, cross-tenant isolation, forged identities, scoped upload tokens, rotation/revocation, ownership after restart, explicit legacy migration, quota accounting, and scheduler caps. Run the HTTP smoke check for each deployment and verify that another agent cannot retrieve or delete its results.
