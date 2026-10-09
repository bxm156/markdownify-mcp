# Markdownify Remote MCP Server

Upload files to a remote server, convert them to Markdown in the background, and retrieve the results through MCP. Each agent owns its files and results, even when multiple agents belong to the same tenant.

This fork of [zcaceres/markdownify-mcp](https://github.com/zcaceres/markdownify-mcp) uses Microsoft MarkItDown for conversion and native **Streamable HTTP** for MCP. The published image is [`bryanmarty/markdownify-mcp`](https://hub.docker.com/r/bryanmarty/markdownify-mcp). Supergateway is not required.

- Supported uploads: PDF, DOCX, XLSX, PPTX, TXT, Markdown, CSV, HTML and JSON.
- Asynchronous conversion with status polling and paginated Markdown retrieval.
- Private agent credentials, scoped upload tokens, tenant/agent quotas and audit logs.
- Temporary retention, explicit deletion and durable job ownership across restarts.

[Install the server](#install-the-server) · [Convert a file](#convert-a-file) · [Configure agent clients](#configure-agent-clients) · [LiteLLM](#connect-through-litellm) · [Agent instructions](SKILL.md)

## How it works

```text
Agent runtime ── MCP calls ──► /mcp
              └─ file PUT ──► /uploads/{id}
                                  │
                           private temporary storage
                                  │
                           background conversion
                                  │
Agent runtime ◄─ Markdown pages ── /mcp
```

MCP controls the job; the runtime transfers the bytes. Connecting an MCP client does not automatically upload local files. The agent also needs filesystem access and an HTTP upload capability, or it can run the included [streaming helper](examples/upload-and-convert.ts). File paths and base64 are not upload tool arguments.

## Install the server

For agents using LiteLLM, the recommended authentication is now [short-lived LiteLLM-signed JWTs](docs/JWT.md), using its open-source outbound signer and a distinct machine user per agent. This requires no Enterprise gateway JWT login. Follow that guide for `compose.jwt.yaml` and gateway client configuration. Binary uploads receive separate one-job credentials valid for at most five minutes. The LiteLLM user ID is the owner; revoking a key or user in LiteLLM stops new admissions, and already-issued tokens and upload grants expire on their own ([details](docs/JWT.md#revocation-is-bounded-not-immediate)).

The steps below remain the standalone per-agent credential-registry alternative. Their direct-client examples use registry tokens; use the gateway examples in the JWT guide for the recommended setup.

### 1. Get the provisioning tools

Install Docker with Compose, Git and Bun 1.4.2. The server image includes Node, Python and MarkItDown; the host does not need a Python installation. Bun runs the credential utility and optional client helper.

```sh
git clone https://github.com/bxm156/markdownify-mcp.git
cd markdownify-mcp
bun install --frozen-lockfile --ignore-scripts
```

### 2. Provision a credential for each agent

```sh
bun scripts/create-agent-credential.ts demo agent-a secrets/agents.json secrets/agent-a.token
bun scripts/create-agent-credential.ts demo agent-b secrets/agents.json secrets/agent-b.token
```

These commands store only token hashes in `secrets/agents.json` and write separate raw token files without printing them. Deliver each token privately to its owning agent runtime. Use a different `agent_id` for every agent that must have isolated files. Credentials with the same tenant and agent IDs intentionally share access for rotation.

The server mounts only the hashed registry. Keep raw tokens out of source control, prompts, logs and image layers. Remove `MD_API_KEY` entirely when using registry authentication.

On Linux, allow container group 10001 to read the registry:

```sh
sudo chgrp 10001 secrets secrets/agents.json
chmod 750 secrets
chmod 640 secrets/agents.json
```

Raw token files retain their private permissions. After provisioning or rotating credentials, reapply these registry permissions and recreate the container; the registry is loaded at startup and its file is atomically replaced. See [credential operations](docs/MULTITENANT.md). Windows Docker Desktop has different bind-mount permission behavior; see the [quickstart](docs/QUICKSTART.md).

### 3. Run the published image

Copy the configuration template:

```sh
cp .env.multitenant.example .env.multitenant
```

In PowerShell, use `Copy-Item .env.multitenant.example .env.multitenant`.

Create `compose.yaml` with:

```yaml
services:
  markdownify:
    image: bryanmarty/markdownify-mcp:latest
    env_file: .env.multitenant
    environment:
      MD_AUTH_FILE: /run/markdownify/agents.json
      MD_HOST: 0.0.0.0
      MD_PORT: 8000
      MD_DATA_DIR: /data
    ports:
      - "127.0.0.1:8000:8000"
    volumes:
      - markdownify-data:/data
      - type: bind
        source: ./secrets/agents.json
        target: /run/markdownify/agents.json
        read_only: true
        bind:
          create_host_path: false
    restart: unless-stopped
    init: true
    read_only: true
    tmpfs:
      - /tmp:size=128m,mode=1777
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 1g
    cpus: 2
    pids_limit: 128
    stop_grace_period: 15s
volumes:
  markdownify-data:
```

Then start it and check health:

```sh
docker compose -f compose.yaml pull
docker compose -f compose.yaml up -d
curl --fail http://localhost:8000/healthz
```

PowerShell can use `Invoke-RestMethod http://localhost:8000/healthz`. The response is `{"status":"ok"}`; `/healthz` is an alias of the `/livez` liveness probe. Use `/readyz` to wait until storage and the converter are ready. Logs are available with `docker compose -f compose.yaml logs`. The local MCP endpoint is `http://localhost:8000/mcp`.

The image runs as UID/GID 10001 and currently supports `linux/amd64`. For a fixed version, replace `latest` with a published `sha-<full commit SHA>` tag or image digest. [Image build and publication details](docs/CONTAINERS.md).

To build from source instead, use the repository configuration:

```sh
docker compose -f compose.multitenant.yaml up --build -d
```

Run one of these configurations at a time, with one server process per private data volume.

### 4. Expose the remote endpoint

Place an HTTPS reverse proxy in front of the localhost listener. Route both `/mcp` and `/uploads/*`, allow PUT, and preserve `Authorization` and `X-Upload-Token`. Configure `.env.multitenant` for the public origin:

```dotenv
MD_PUBLIC_BASE_URL=https://markdownify.example.com
# If the proxy rewrites Host, include the value it forwards:
MD_ALLOWED_HOSTS=markdownify.example.com,localhost:8000,127.0.0.1:8000
```

Recreate the container after changing configuration. `MD_PUBLIC_BASE_URL` is an origin without `/mcp`; agents connect to `https://markdownify.example.com/mcp`. Generated upload URLs must point to that same reachable origin. HTTPS hosting and live LiteLLM integration must be verified in your deployment. See [remote deployment](docs/REMOTE.md).

## Convert a file

Run the helper on the client machine that can read the document. From the cloned repository, load that agent's token into its environment.

Bash:

```sh
export MCP_URL=https://markdownify.example.com/mcp
export MARKDOWNIFY_TOKEN="$(cat secrets/agent-a.token)"
export MCP_TOKEN="$MARKDOWNIFY_TOKEN"
bun examples/upload-and-convert.ts ./report.pdf ./report.md
```

PowerShell:

```powershell
$env:MCP_URL = 'https://markdownify.example.com/mcp'
$env:MARKDOWNIFY_TOKEN = (Get-Content secrets/agent-a.token -Raw).Trim()
$env:MCP_TOKEN = $env:MARKDOWNIFY_TOKEN
bun examples/upload-and-convert.ts ./report.pdf ./report.md
```

For local testing, use `http://localhost:8000/mcp`. The helper streams the file, starts conversion, polls with a deadline and saves paginated Markdown. It preserves existing output files and leaves the remote job available until retention expires. Keep runtime environment variables out of model instructions and logs.

For direct tool use, follow [SKILL.md](SKILL.md):

| Step | Tool or request | Arguments / behavior |
| --- | --- | --- |
| Reserve | `create_upload` | `{"filename":"report.pdf","size_bytes":12345}` using the actual byte count |
| Transfer | HTTP PUT to returned `upload_url` | Raw file bytes, owner bearer `Authorization`, returned `X-Upload-Token` and `Content-Type`; reject redirects |
| Start | `start_conversion` | `{"upload_id":"<upload_id>"}` |
| Poll | `get_conversion_status` | `{"job_id":"<job_id>"}` until `completed` or failure, with a finite deadline |
| Retrieve | `get_markdown` | `{"job_id":"<job_id>","offset":0,"max_chars":50000}`; follow `next_offset` until null |
| Clean up | `delete_job` | `{"job_id":"<job_id>"}` when the saved result and requested retention permit deletion |
| Explain a failure | `lookup_error` | `{"code":"OUTPUT_LIMIT_EXCEEDED"}` for recovery steps; actual limits are in the original error |

Check MCP `isError` before parsing JSON from text result blocks. Failures include `error_info` with a stable code, recovery steps, retry guidance and applicable limits. Failed status results also include `error_info`; stop polling and follow that guidance. Use `lookup_error` for explanations; see [error recovery](docs/ERRORS.md). Pagination offsets count Unicode code points. One job is one file upload, its conversion state and its result. Preserve the job ID for later retrieval; another agent cannot use it. Scanned PDFs do not carry an OCR guarantee.

## Configure agent clients

Replace the example origin with your server. Supply a separately provisioned token to each agent process; using the same credential across clients makes them the same logical owner. Start or restart the client with `MARKDOWNIFY_TOKEN` available in its environment. An editor launched from a desktop shortcut may not inherit a terminal's environment.

The examples configure MCP access. File conversion also needs a runtime that can upload bytes as described above. Give the agent [SKILL.md](SKILL.md) as instructions, or ask it to read the file before converting. A suitable request is: “Use Markdownify to convert this accessible PDF, save the Markdown, and retain the job ID for later retrieval.”

### Codex CLI / IDE extension

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.markdownify]
url = "https://markdownify.example.com/mcp"
bearer_token_env_var = "MARKDOWNIFY_TOKEN"
```

Use `codex mcp list` to check registration. The CLI and IDE extension share this configuration. [Official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

### Claude Code

Add this to your project's `.mcp.json`, merging with any existing servers:

```json
{
  "mcpServers": {
    "markdownify": {
      "type": "http",
      "url": "https://markdownify.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MARKDOWNIFY_TOKEN}"
      }
    }
  }
}
```

Claude Code expands the environment variable in the header. Use `claude mcp list` or `/mcp` to inspect the connection, and approve the project server when prompted. [Official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

### Cursor

Add to `.cursor/mcp.json` for a project, or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "markdownify": {
      "url": "https://markdownify.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:MARKDOWNIFY_TOKEN}"
      }
    }
  }
}
```

Cursor uses `${env:NAME}` interpolation. Enable the server in its MCP settings and confirm the seven remote tools are available. [Official Cursor MCP documentation](https://cursor.com/docs/mcp).

### VS Code / GitHub Copilot, local extension session

For the VS Code configuration format, add to `.vscode/mcp.json`:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "markdownifyToken",
      "description": "This agent's Markdownify bearer token",
      "password": true
    }
  ],
  "servers": {
    "markdownify": {
      "type": "http",
      "url": "https://markdownify.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${input:markdownifyToken}"
      }
    }
  }
}
```

Supply the token in the private input prompt. Use **MCP: List Servers** to start/check the server, then enable its tools in Agent chat. This interactive-input example applies to local extension sessions; VS Code Agent Host sessions do not receive configurations requiring interactive inputs. For portable Agent Host configuration, follow the vendor's `.mcp.json` guidance with credentials available to that runtime. [Official VS Code configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

Client snippets are checked against vendor documentation; automated integration tests exercise the MCP SDK/server protocol, not every editor UI.

## Connect through LiteLLM

Configure the upstream without a shared static credential so each agent can forward its own identity:

```yaml
mcp_servers:
  markdownify:
    url: https://markdownify.example.com/mcp
    transport: http
    auth_type: none
```

Point the agent's MCP client at `https://litellm.example.com/markdownify/mcp` and send:

```text
x-litellm-api-key: Bearer <agent LiteLLM virtual key>
x-mcp-markdownify-authorization: Bearer <agent Markdownify token>
```

Grant that virtual key access to the `markdownify` server. The forwarding header's alias must match the LiteLLM configuration. Tool names may be prefixed, so discover them from the gateway. Binary uploads still go directly to Markdownify with the owner's bearer credential plus scoped upload token.

The helper supports this configuration:

```sh
export MCP_URL=https://litellm.example.com/markdownify/mcp
export LITELLM_API_KEY='<agent LiteLLM virtual key>'
export MARKDOWNIFY_AGENT_TOKEN="$MARKDOWNIFY_TOKEN"
export MARKDOWNIFY_BASE_URL=https://markdownify.example.com
bun examples/upload-and-convert.ts ./report.docx ./report.md
```

Verify forwarding with two distinct agents in your own LiteLLM deployment. [Identity forwarding details](docs/MULTITENANT.md#litellm-identity-forwarding) · [Official LiteLLM reference](https://docs.litellm.ai/docs/mcp_config_reference).

## Limits and troubleshooting

Defaults are 25 MiB per input and output, 24-hour retention, 15-minute upload tokens and a 120-second conversion timeout. Global, tenant and agent budgets also limit job admission and concurrent conversions. Small inputs reserve the maximum output budget. Configure limits in [.env.multitenant.example](.env.multitenant.example); [quota details](docs/MULTITENANT.md#budgets-and-scheduling). In JWT mode tenant and agent limits both apply to each LiteLLM user ([effective limits](docs/JWT.md#effective-per-user-limits)). Operators can set per-agent caps with `MD_QUOTA_OVERRIDES_FILE` ([operator quota overrides](docs/MULTITENANT.md#operator-quota-overrides)).

| Symptom | Check |
| --- | --- |
| HTTP 401 | Agent credential is active and sent in bearer `Authorization`; restart after registry changes |
| `Job not found` / HTTP 404 | Job ID and owner identity match; foreign jobs receive the same response as unknown IDs |
| Upload URL points to localhost | Set `MD_PUBLIC_BASE_URL` to the reachable server origin and recreate the container |
| Host/origin rejected | Proxy preserves the intended Host or its forwarded Host is explicitly allowed |
| Capacity exhausted / HTTP 507 | Retention, job counts and input-plus-output reservations fit all three quota scopes |
| Client lists tools but cannot convert a local file | Provide runtime filesystem/HTTP upload access or run the helper |
| Registry unreadable or changes ignored | Check UID/GID permissions and recreate the file bind mount after atomic registry replacement |

Run one process per data volume. Application ownership is not a sandbox for hostile document parser exploits. Public hosting and live LiteLLM verification remain deployment work; multi-worker/distributed storage is deferred.

## Development and local stdio mode

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build:remote
bun test src/remote
```

Root `bun test` runs both the stdio and remote suites (the stdio tests need `markitdown` installed). The tests that clone real GitHub repositories are skipped unless `MD_TEST_NETWORK` is exactly `1`; any other value (including `0` or `false`) leaves them skipped.

CI tests every push and PR, including real PDF/Office conversions, Docker builds and three-agent isolation. Main-branch publication tests the image before pushing `latest` and commit-SHA tags to Docker Hub. See [containers](docs/CONTAINERS.md), [validation history](docs/MULTITENANT-VALIDATION.md) and [milestones](PLAN.md).

The upstream local stdio entry point remains `dist/index.js` (`bun start`) with local-path and web conversion tools. It is separate from the remote `dist/remote/index.js` service and its seven remote tools. Local mode needs its own Python/dependency setup; the original `Dockerfile` builds stdio mode, while `Dockerfile.remote` builds the service documented here.

## Further documentation

- [Fresh deployment quickstart](docs/QUICKSTART.md)
- [Remote HTTP settings and operations](docs/REMOTE.md)
- [Private-agent credentials, quotas and LiteLLM](docs/MULTITENANT.md)
- [Agent usage skill](SKILL.md)
- [Container images and Docker Hub publishing](docs/CONTAINERS.md)
- [Health monitoring: real readiness and LiteLLM 1.104 probes](docs/HEALTH.md). GET /livez (alias /healthz) is a liveness probe; GET /readyz returns 503 until storage, the converter and startup are ready and publishes only boolean checks. Authenticated agents can call `get_service_health` for their own queue/reservation metrics, configured limits and effective limits; identity-free probes never gain file access.

## License

[MIT](LICENSE).
