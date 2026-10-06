# Remote file conversion MVP

This fork adds a native Streamable HTTP MCP server at `/mcp`, a binary upload endpoint, and a bounded background conversion queue. Start with [QUICKSTART.md](QUICKSTART.md) for a new deployment with private agent credentials, or [MULTITENANT.md](MULTITENANT.md) for authentication, quotas, and LiteLLM forwarding. Run exactly one process/replica per data directory. Job metadata is stored in atomic JSON manifests on disk, alongside input and Markdown files; there is no external database or queue. The original stdio tools remain available separately. The optional `MD_API_KEY` setup below is for one logical agent only; use `MD_AUTH_FILE` for multiple agents.

## Agent workflow

1. Call `create_upload` with `{ "filename": "report.docx", "size_bytes": 12345 }`.
2. The result contains `upload_id`, `upload_url`, `required_headers`, and `expires_at`. The agent **runtime**, with access to the local file, must HTTP `PUT` its raw bytes to that URL using those headers plus its own `Authorization: Bearer <agent credential>`. Do not include bytes or base64 in model context. The upload URL has no secret query parameters; `required_headers.X-Upload-Token` carries a short-lived upload token. The server never returns the long-lived agent credential.
3. Call `start_conversion` with `{ "upload_id": "..." }`; receive `job_id` immediately. This operation is idempotent for a queued/running/completed job.
4. Poll `get_conversion_status` with `{ "job_id": "..." }`, with backoff and a deadline.
5. When status is `completed`, call `get_markdown` with `{ "job_id": "...", "offset": 0, "max_chars": 50000 }`. Append `markdown`, then follow `next_offset` until it is `null`. Offsets count Unicode code points, not bytes. The server bounds page size to 100,000 characters and avoids splitting a surrogate pair.
6. Optionally call `delete_job` with `{ "job_id": "..." }` when done. Otherwise retention cleanup removes temporary content.

States are `awaiting_upload → uploaded → queued → running → completed/failed → expired`. Upload retries require the same original bytes and a token that has not expired. After a successful upload, the scoped upload token is invalidated. On restart, queued conversions resume, interrupted running conversions become failed, and partial uploads are discarded. Re-upload a failed conversion as a new job. Polling does not extend retention.

The allowlist is PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, HTML, and JSON. The remote tools accept generated IDs, not server filesystem paths or arbitrary URLs. Scanned PDFs require a separate OCR capability and complex document layouts may not reproduce faithfully in Markdown.

## Local setup

Use Bun for this repository's package management. The portable remote build produces JavaScript runnable with Node 22 or later.

```sh
bun install --frozen-lockfile --ignore-scripts
python -m venv .venv
# Unix:
.venv/bin/pip install 'markitdown[pdf,docx,xlsx,pptx]==0.1.5'
# Windows instead:
# .venv\Scripts\python -m pip install "markitdown[pdf,docx,xlsx,pptx]==0.1.5"
bun run build:remote
```

Copy `.env.remote.example` to `.env.remote`, set `MD_API_KEY` to a random secret of at least 32 characters, and load its values into the environment of the server process. The native Node entry does not automatically load `.env.remote`. Node 22 can load it explicitly:

```sh
node --env-file=.env.remote dist/remote/index.js
```

Generate a key without storing it in the image:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`MARKITDOWN_PATH` can point to an installed executable when it is not on PATH or in the project `.venv`. The `/healthz` endpoint is a liveness probe and does not prove a document can be converted; run the fixture smoke test below for converter validation.

## Docker deployment

```sh
cp .env.remote.example .env.remote
# Edit MD_API_KEY and MD_PUBLIC_BASE_URL in .env.remote before starting.
docker compose -f compose.remote.yaml up --build -d
docker compose -f compose.remote.yaml logs --tail=100
```

The image installs MarkItDown 0.1.5 with the PDF/Office extras, runs as a non-root user, and stores jobs in the `markdownify-data` volume. Compose publishes port 8000 on the host's loopback interface, uses a read-only root filesystem with temporary scratch storage, and bounds container resources. The volume survives container replacement. `docker compose down -v` deletes it and all jobs. Do not share this volume between replicas.

Put a TLS reverse proxy in front of the local port for remote access. Set `MD_PUBLIC_BASE_URL=https://markdownify.example.com` to the **origin** accessible directly from the agent runtime. It must have no path, query, userinfo, or fragment. The proxy must route both `/mcp` and `/uploads/*` to this service, preserve the public `Host`, `Authorization`, and `X-Upload-Token` headers, allow `PUT`, and accept at least the configured maximum upload size. Configure proxy upload/body limits and timeouts to match your actual files. If the proxy rewrites Host, explicitly set `MD_ALLOWED_HOSTS` to a comma-separated allowlist of the public and internal host:port values needed. CORS browser uploads are not provided; this MVP targets server-side agent runtimes.

Supergateway is unnecessary for this entry point because it already speaks Streamable HTTP. Wrapping the legacy stdio entry in Supergateway exposes the legacy tools, not these upload tools. Use the native `/mcp` endpoint for this workflow.

## LiteLLM connection

For a single logical agent using legacy-key mode, add this to your LiteLLM configuration; load `MARKDOWNIFY_MCP_TOKEN` with the same value as the converter's `MD_API_KEY` in the LiteLLM process:

```yaml
mcp_servers:
  markdownify:
    url: https://markdownify.example.com/mcp
    transport: http
    auth_type: bearer_token
    auth_value: os.environ/MARKDOWNIFY_MCP_TOKEN
```

Grant the agent's LiteLLM virtual key access to the `markdownify` MCP server. Connect the agent MCP client to `https://litellm.example.com/markdownify/mcp` using `x-litellm-api-key: Bearer <virtual-key>`. LiteLLM may prefix tool names with its server alias, such as `markdownify-create_upload`; discover the tool list rather than hardcoding gateway names. The gateway key and upstream `MD_API_KEY` are separate credentials. Binary `PUT` requests go directly from the agent runtime to Markdownify, using its own bearer credential plus the returned scoped token; LiteLLM carries tool calls, not file bytes. For multiple isolated agents, follow [MULTITENANT.md](MULTITENANT.md) and forward each agent credential instead of configuring this shared static token.

This configuration follows the [LiteLLM MCP configuration reference](https://docs.litellm.ai/docs/mcp_config_reference), checked through Firecrawl on October 6, 2026. Live LiteLLM interoperability and internet deployment still require testing in your deployment environment.

## Streaming runtime example

`examples/upload-and-convert.ts` uses the MCP SDK, discovers direct or gateway-prefixed tools, streams a local file, polls with a finite deadline, and writes paginated Markdown to a new file. It refuses to overwrite an existing output and does not log the upload token. Set environment variables using your shell or secret manager:

```sh
# Direct connection:
export MCP_URL=http://localhost:8000/mcp
export MCP_TOKEN='<same secret as MD_API_KEY>'
bun examples/upload-and-convert.ts ./report.docx ./report.md

# Through LiteLLM:
export MCP_URL=https://litellm.example.com/markdownify/mcp
export LITELLM_API_KEY='<agent virtual key>'
export MARKDOWNIFY_BASE_URL=https://markdownify.example.com
export MARKDOWNIFY_AGENT_TOKEN='<same secret as MD_API_KEY>'
bun examples/upload-and-convert.ts ./report.pdf ./report.md
```

For PowerShell use `$env:MCP_URL='...'` (and similarly for other variables) instead of `export`. `CONVERSION_DEADLINE_MS` controls the example's total deadline, default 300,000 ms. A timeout leaves the server job available until retention cleanup; an incomplete output file is reported for manual removal. Remote credentials require HTTPS; plain HTTP is accepted only for loopback development.

## Limits and retention

| Variable | Default | Purpose |
| --- | --- | --- |
| `MD_API_KEY` | Required in legacy mode, ≥32 characters | Bearer credential for the single default/default agent; must be absent when MD_AUTH_FILE is set |
| `MD_AUTH_FILE` | Required for isolated agents | Trusted hashed credential registry; see [MULTITENANT.md](MULTITENANT.md) |
| `MD_PUBLIC_BASE_URL` | `http://localhost:8000` | Direct upload origin |
| `MD_HOST` / `MD_PORT` | `127.0.0.1` / `8000` | Listener; Compose overrides host to `0.0.0.0` |
| `MD_ALLOWED_HOSTS` | Public host and local probe hosts | Explicit Host allowlist override |
| `MD_DATA_DIR` | `./data` | Persistent temporary job directory |
| `MD_MAX_UPLOAD_BYTES` | 26,214,400 (25 MiB) | Single input limit |
| `MD_MAX_OUTPUT_BYTES` | 26,214,400 (25 MiB) | Markdown output limit |
| `MD_MAX_STORAGE_BYTES` | 268,435,456 (256 MiB) | Reservation budget for input plus maximum output per live job |
| `MD_MAX_JOBS` | 100 | Live job limit; storage reservation usually binds first |
| `MD_RETENTION_MS` | 86,400,000 (24 hours) | Completed/failed result retention |
| `MD_UPLOAD_TTL_MS` | 900,000 (15 minutes) | Abandoned upload expiry |
| `MD_CONVERSION_TIMEOUT_MS` | 120,000 (2 minutes) | Converter process deadline |
| `MD_CONCURRENCY` | 2 | Maximum active converters |

Storage reservations are conservative: even a small file reserves the full configured Markdown output limit. Increase storage or lower output limits to accommodate more live jobs. JSON manifests and scratch buffers add overhead; the application budget is not a filesystem quota. Use a dedicated volume with adequate free space. Store it on an encrypted disk if document confidentiality requires it. Do not log upload authorization headers or whole `create_upload` results in agent traces.

The converter is a subprocess with a timeout and bounded stdout; it is not a security sandbox for hostile document parser exploits. The current service isolates files by authenticated tenant and agent, with tenant/agent budgets and metadata auditing. It assumes trusted document sources and has no distributed queue, OCR service, or live deployment automation. See [MULTITENANT.md](MULTITENANT.md) for deployment limits and ownership migration.

## Verification

```sh
bun run build:remote
bun test src/remote
bun scripts/remote-converter-smoke.ts
# With a server running and MCP_TOKEN set:
bun scripts/remote-http-smoke.ts
```

The remote tests exercise authentication, upload/job lifecycle, limits, expiry, restart behavior, and Markdown pagination with controlled converter fixtures. The converter smoke script exercises actual MarkItDown against the repository's real PDF and newly generated OOXML DOCX, XLSX and PPTX files (the upstream Office samples are plain-text placeholders). The HTTP smoke script exercises MCP initialization/tool discovery, streaming PDF upload, conversion, paginated retrieval, and deletion. The dedicated `Remote MVP` GitHub workflow runs these checks on Linux, builds the image, starts a test container with a generated masked key, and verifies its HTTP workflow. Confirm the workflow succeeds before operating the public service. Live LiteLLM interoperability requires a separate deployment check; no deployment credentials are embedded in the repository.
