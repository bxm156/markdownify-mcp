# Markdownify Remote MCP Server

Markdownify is a remote [MCP](https://modelcontextprotocol.io/) server that turns documents into Markdown for AI agents. An agent's runtime uploads a file, the server converts it in the background with Microsoft [MarkItDown](https://github.com/microsoft/markitdown), and the agent reads the Markdown back in pages. Every upload and result is private to the agent that created it.

It is a fork of [zcaceres/markdownify-mcp](https://github.com/zcaceres/markdownify-mcp) that speaks native Streamable HTTP at `/mcp` (no Supergateway) and ships as the Docker image [`bryanmarty/markdownify-mcp`](https://hub.docker.com/r/bryanmarty/markdownify-mcp).

## Who this is for

- **Operators** who host one conversion service for several agents, often behind a [LiteLLM](https://docs.litellm.ai/) gateway, and need per-agent isolation, quotas and health checks.
- **Agent builders** who want their agents to read PDFs and Office files without passing file bytes or base64 through the model's context.

## What it does

- Converts PDF, DOCX, XLSX, PPTX, TXT, Markdown, CSV, HTML and JSON uploads. Scanned PDFs carry no OCR guarantee.
- Runs conversions asynchronously, with status polling and paginated Markdown retrieval.
- Keeps every job private to one tenant and agent; agents in the same tenant cannot see each other's files.
- Enforces global, tenant and agent budgets, keeps metadata-only audit logs and deletes results after a retention period.
- Exposes `GET /livez` (alias `/healthz`) for liveness and `GET /readyz` for readiness, plus per-agent usage through the `get_service_health` tool.

## The 60-second mental model

MCP controls the job; the agent's runtime moves the bytes. The model never names a local path or sends file content as a tool argument.

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

1. **Reserve.** `create_upload` with the file name and exact size returns an `upload_id`, an `upload_url` and short-lived upload headers.
2. **Upload.** The runtime streams the raw bytes with HTTP `PUT` to `upload_url`, using those headers.
3. **Convert.** `start_conversion` with the `upload_id` returns a `job_id` immediately.
4. **Poll.** `get_conversion_status` with backoff and a finite deadline, until the job is `completed` or `failed`. A `JOB_EXPIRED` error (HTTP 410) is also terminal: stop polling and create a fresh upload if the document is still needed.
5. **Read.** `get_markdown` returns pages; follow `next_offset` until it is `null`.
6. **Clean up.** `delete_job` when the result is saved, or let retention remove it (24 hours by default).

When something fails, the error carries a stable code with recovery steps, and `lookup_error` explains any code. The included [streaming helper](https://github.com/bxm156/markdownify-mcp/blob/main/examples/upload-and-convert.ts) runs the whole sequence from the command line. Give agents the [agent skill](agent-skill.md) so they follow the same steps.

## Authentication at a glance

Each server runs in exactly one mode; the modes cannot be combined.

| Mode | Configure with | Agent identity comes from | Use when |
| --- | --- | --- | --- |
| [LiteLLM-signed JWT](JWT.md) (recommended) | `MD_JWT_ISSUER`, `MD_JWT_AUDIENCE`, `MD_JWT_JWKS_URL` | The verified JWT subject: one LiteLLM machine user per agent | Agents reach the server through LiteLLM, using its open-source `mcp_jwt_signer`. No Enterprise license or long-lived Markdownify keys. |
| [Credential registry](MULTITENANT.md) | `MD_AUTH_FILE` | A hashed per-agent bearer token mapped to a tenant and agent | Standalone deployments, or LiteLLM forwarding each agent's own token. |
| [Single shared key](REMOTE.md) | `MD_API_KEY` | None: every holder is the same `default/default` agent | One logical agent only. It cannot isolate agents. |

In JWT mode, uploads use a separate one-job credential that expires within five minutes and cannot call MCP tools.

## Where to go next

| I want to… | Read |
| --- | --- |
| Install the server and connect Codex, Claude Code, Cursor or VS Code | [Install and connect clients](install.md) |
| Stand up a fresh multi-agent deployment and check isolation | [Fresh deployment quickstart](QUICKSTART.md) |
| Put agents behind LiteLLM with short-lived JWTs | [LiteLLM JWT authentication](JWT.md) |
| Provision agent credentials, set quotas or forward identities | [Private agents, quotas and LiteLLM](MULTITENANT.md) |
| Configure HTTP settings, limits, retention and the reverse proxy | [Remote HTTP service](REMOTE.md) |
| Build or pull the Docker image | [Container images](CONTAINERS.md) |
| Monitor readiness or wire up LiteLLM health probes | [Health checks](HEALTH.md) |
| Look up an error code and its recovery | [Errors and recovery](ERRORS.md) |
| Teach an agent the tool workflow | [Agent skill](agent-skill.md) |
| See milestones and what has been verified | [Plan and milestones](plan.md) |

!!! note "Current limits"
    Run one server process per data volume; multiple replicas and distributed storage are deferred. The converter runs with time and output limits but is not a sandbox against hostile documents. Public hosting and live LiteLLM verification remain checks for your own deployment.
