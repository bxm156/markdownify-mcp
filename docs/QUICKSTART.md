# Fresh multi-agent deployment

Use this guide for a new server and new clients. A job is one file upload plus its conversion and Markdown result. Assign each agent a different `agent_id`; a shared tenant groups quotas, while files stay private to the owning agent.

## 1. Get the source and provision two agents

Install Git, Bun 1.4.2, and Docker with Compose, then clone this repository and enter its root:

```sh
git clone https://github.com/bxm156/markdownify-mcp.git
cd markdownify-mcp
bun install --frozen-lockfile --ignore-scripts
bun scripts/create-agent-credential.ts demo agent-a secrets/agents.json secrets/agent-a.token
bun scripts/create-agent-credential.ts demo agent-b secrets/agents.json secrets/agent-b.token
```

The commands work in Bash and PowerShell. They write token hashes to `secrets/agents.json` and separate raw bearer tokens to the requested new files. Tokens are not printed. Supply each raw token only to its owner's runtime through your secret manager. The server receives only the registry. Different credentials for the same `(tenant_id, agent_id)` intentionally share that agent's files; use different agent IDs for isolation.

On Linux, make the registry readable by container group 10001 without opening raw token files:

```sh
sudo chgrp 10001 secrets secrets/agents.json
chmod 750 secrets
chmod 640 secrets/agents.json
# Raw agent token files retain their private 600 permissions.
```

Windows Docker Desktop handles bind-mount permissions differently; verify the container can read the registry without granting other host users access to token files. On every registry update, reapply required Linux permissions and recreate the container so the bind mount sees the replaced registry file.

## 2. Start locally

Bash:

```sh
cp .env.multitenant.example .env.multitenant
docker compose -f compose.multitenant.yaml up --build -d
curl --fail http://localhost:8000/healthz
```

PowerShell:

```powershell
Copy-Item .env.multitenant.example .env.multitenant
docker compose -f compose.multitenant.yaml up --build -d
Invoke-RestMethod http://localhost:8000/healthz
```

The default listener is bound to localhost through Docker. The expected health response is `{"status":"ok"}`. Inspect `docker compose -f compose.multitenant.yaml logs` if startup fails. Remove `MD_API_KEY` entirely from this server's environment; registry authentication uses `MD_AUTH_FILE` and rejects a simultaneous shared key. Use this Compose file on its own.

For public hosting, configure HTTPS and routing as described in [containers](CONTAINERS.md) and [remote deployment](REMOTE.md). Configure `MD_PUBLIC_BASE_URL` to your server origin before accepting remote clients. Run one replica per data volume. The Docker Hub image `bryanmarty/markdownify-mcp` becomes available after the configured publication workflow succeeds; local builds do not require Docker Hub credentials.

## 3. Convert from each client

Run clients outside the container, where their input files are accessible. Bash, agent A:

```sh
export MCP_URL=http://localhost:8000/mcp
export MCP_TOKEN="$(cat secrets/agent-a.token)"
bun examples/upload-and-convert.ts src/sample-data/test.pdf agent-a-result.md
unset MCP_TOKEN
```

PowerShell, agent A:

```powershell
$env:MCP_URL = 'http://localhost:8000/mcp'
$env:MCP_TOKEN = (Get-Content secrets/agent-a.token -Raw).Trim()
bun examples/upload-and-convert.ts src/sample-data/test.pdf agent-a-result.md
Remove-Item Env:MCP_TOKEN
```

Repeat using `agent-b.token` and a different output filename for agent B. Successful output contains `Test PDF content`. Existing output files are preserved; choose a new filename when retrying. The helper streams bytes directly with the agent's bearer credential and returned upload token, starts conversion, polls with a deadline, and retrieves code-point pages. Jobs remain until temporary retention expires.

For agents using MCP tools directly, load [SKILL.md](../SKILL.md). It describes all five tools, JSON result parsing, scoped binary upload, finite polling, pagination, and authorized cleanup. A runtime capable of HTTP file upload is necessary; a model passing a local path cannot transfer bytes.

## 4. Verify isolation before granting access

With agent A's MCP connection, call `create_upload` for a small supported file and retain its upload ID. Using agent B's connection, call `get_conversion_status` with that ID. Expect `isError: true` and `Job not found`, including when both agents use the `demo` tenant. Agent B's PUT to the upload URL must also return HTTP 404 even if it has A's scoped upload token. A's credential should still upload, convert, retrieve, and delete its own job successfully.

The repository's `scripts/multitenant-http-smoke.ts` performs fuller checks with a disposable three-agent registry, including cross-tenant isolation and real PDF conversion. CI runs this against the built container. See [multi-agent configuration](MULTITENANT.md) for LiteLLM identity forwarding, quotas, credential rotation, and the verification details. Keep agent bearer credentials distinct through LiteLLM; a shared upstream credential makes requests identify as one agent.
