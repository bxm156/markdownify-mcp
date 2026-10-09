# LiteLLM-signed JWT authentication (no Enterprise gateway auth)

Use a distinct LiteLLM machine user/virtual key per agent. LiteLLM authenticates that virtual key and signs the outgoing MCP request with a short-lived RS256 JWT. Markdownify verifies it against the configured public JWKS and uses the signed subject (the LiteLLM user ID) as the private owner of every job. Clients need no long-lived Markdownify key.

This uses the open-source outbound `mcp_jwt_signer`, not the Enterprise `enable_jwt_auth` gateway login feature. LiteLLM 1.104.0's guardrail initializer and per-agent signing were executed locally with LITELLM_LICENSE unset. Its actual tokens/public keys passed the compiled Node/PDF/upload/helper smoke. The implementation was also checked in [LiteLLM public source at 10444df](https://github.com/BerriAI/litellm/tree/10444df3a0173a99ab4e4858ce6777f31530e6c5/litellm/proxy/guardrails/guardrail_hooks/mcp_jwt_signer). Check your installed version has this guardrail and JWKS endpoint; older releases may need an upgrade. [Official signer documentation](https://docs.litellm.ai/docs/mcp_zero_trust).

## 1. Configure LiteLLM

Add/merge this with your existing LiteLLM configuration:

```yaml
mcp_servers:
  markdownify:
    url: https://markdownify.example.com/mcp
    transport: http
    auth_type: none

guardrails:
  - guardrail_name: markdownify-jwt-signer
    litellm_params:
      guardrail: mcp_jwt_signer
      mode: pre_mcp_call
      default_on: true
      issuer: https://litellm.example.com
      audience: markdownify
      ttl_seconds: 300
      end_user_claim_sources:
        - litellm:user_id
```

`auth_type: none` means no static upstream key; it does not make Markdownify public. The guardrail injects signed Authorization, and Markdownify rejects unsigned requests. Keep gateway admission enabled. Do not select `true_passthrough`, shared static upstream credentials or Enterprise JWT login for this setup.

Persist an RSA signing key in the LiteLLM deployment, supplied privately:

```text
MCP_JWT_SIGNING_KEY=file:///run/secrets/mcp-signing-key.pem
```

For example, an operator can generate it with `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out mcp-signing-key.pem`, set private permissions, and mount it read-only into LiteLLM. Never mount the private key into Markdownify or commit it. Only LiteLLM's public `/.well-known/jwks.json` is needed by Markdownify. Automatically generated signing keys are lost when LiteLLM restarts.

Create separate LiteLLM machine users, e.g. `markdownify-agent-a` and `markdownify-agent-b`, and virtual keys attached to those users with `object_permission.mcp_servers: ["markdownify"]`. These are standard virtual-key operations backed by LiteLLM's database; configure them in your existing gateway. Use the machine user's own identity, not a shared master/admin key. Give each key only the necessary tool access.

Two keys attached to the same `user_id` intentionally resolve to the same agent, which supports key rotation. Different agents must have different user IDs. LiteLLM's stored upstream credentials also belong to user IDs, not individual keys. [Machine-user/key provisioning reference](https://docs.litellm.ai/docs/mcp_per_user_auth).

The signer generates `mcp:tools/list` and per-tool call scopes. Markdownify requires list scope for discovery, and both `mcp:tools/call` plus `mcp:tools/<name>:call` for execution. It also accepts a configured alias prefix (`markdownify-` by default). Leave scope auto-generation enabled; do not replace it with an unrelated generic scope. Verify your gateway injects JWTs for upstream initialization, discovery and execution; unsupported older gateway versions must be upgraded rather than weakening server checks.

## 2. Agent identity comes from LiteLLM

There is no subject map. Agents cannot forge LiteLLM's signature, so the verified `sub` claim is the owner: each LiteLLM user ID is its own tenant and agent, and its jobs are invisible to every other user ID. Access is managed entirely in LiteLLM (machine users, virtual keys, `object_permission.mcp_servers`).

User IDs must match `[A-Za-z0-9_-]{1,64}` (e.g. `markdownify-agent-a`); tokens with any other subject are rejected, as is LiteLLM's shared fallback subject `litellm-proxy`. Caller headers, tool arguments, JWT `act`, email and tenant claims cannot change the owner. Renaming a user ID changes the owner, so its earlier jobs become unreachable.

There are no existing deployments, so there is no migration or backward-compatibility path for the removed subject map: no allowlist, mapped tenant/agent IDs, disabled-subject list or map reload exists, and Markdownify cannot deny a user the gateway admits. Registry mode (`MD_AUTH_FILE`) is a separate standalone mode and cannot be combined with JWT mode.

### Effective per-user limits

The verified user ID is both tenant and agent, so the tenant and agent limits both apply to the same user. `createUpload` checks the global, tenant and agent scopes independently and denies the reservation if any one is full; `pump()` starts a queued job only if global, tenant and agent concurrency all have room. The effective cap for one user is the minimum across the three scopes. Defaults:

| Limit | Global | Tenant | Agent | Effective per user |
| --- | --- | --- | --- | --- |
| Live jobs (`MD_MAX_JOBS`, `MD_MAX_TENANT_JOBS`, `MD_MAX_AGENT_JOBS`) | 100 | 25 | 10 | 10 |
| Reserved bytes (`MD_MAX_STORAGE_BYTES`, `MD_MAX_TENANT_STORAGE_BYTES`, `MD_MAX_AGENT_STORAGE_BYTES`) | 256 MiB | 128 MiB | 128 MiB | 128 MiB |
| Active conversions (`MD_CONCURRENCY`, `MD_MAX_TENANT_CONCURRENCY`, `MD_MAX_AGENT_CONCURRENCY`) | 2 | 1 | 1 | 1 |

Every job reserves its declared input size plus `MD_MAX_OUTPUT_BYTES` (25 MiB), so the default 128 MiB admits at most five live jobs, fewer with larger inputs (a 25 MiB input leaves room for two), before the 10-job cap can apply. Jobs count until deleted or expired. The global limits are shared by all users, so one busy user can exhaust them for others even below its own caps, and `MD_CONCURRENCY` bounds how many users convert at once. Raising an agent limit above the matching tenant limit has no effect, so raise both. `get_service_health` reports the configured caps and the caller's own usage.

### Revocation is bounded, not immediate

Blocking or deleting a LiteLLM key or user stops new gateway admissions, so LiteLLM stops signing new JWTs for it. Markdownify keeps no revocation list and does not see LiteLLM state. Credentials already issued stay valid until they expire:

- A JWT is accepted until its `exp`, which cannot be more than `MD_JWT_MAX_TTL_SECONDS` after `iat` (default 300, maximum 3600). `exp` has no clock tolerance. `iat` may be up to five seconds ahead of the Markdownify clock, so a token can be usable for up to five seconds longer than its TTL if the signer's clock is ahead. Keep the LiteLLM `ttl_seconds` at or below `MD_JWT_MAX_TTL_SECONDS`; longer tokens are rejected. Agents do not normally see the JWT; this bounds a captured or in-flight token.
- An upload grant is valid for at most five minutes (`Math.min(MD_UPLOAD_TTL_MS, 300000)`) and can only complete that one upload.
- Existing jobs and results are not deleted. They remain until `MD_RETENTION_MS` (default 24 hours) or `delete_job`, and a later key for the same user ID reaches them again.
- To cut off sooner, lower `MD_JWT_MAX_TTL_SECONDS` and the signer `ttl_seconds`. Rotating the LiteLLM signing key invalidates tokens for all users only once the old key is removed from the JWKS and Markdownify's 60-second JWKS cache refreshes.

If your gateway cannot run the `mcp_jwt_signer` guardrail, the alternative is registry mode with LiteLLM forwarding or storing each user's Markdownify credential; see [stored per-user credentials](MULTITENANT.md#stored-per-user-credentials-in-litellm) for the setup and trade-offs. The two modes cannot be combined in one deployment.

LiteLLM's on-behalf-of mode (`auth_type: oauth2_token_exchange`) exchanges the caller's identity-provider token for an access token scoped to the MCP server (RFC 8693, or the Entra ID `jwt-bearer` profile) and forwards that provider-issued token instead of signing its own. Markdownify does not support this today: the verifier pins one issuer and JWKS, which would have to be the provider's rather than LiteLLM's, and it requires `mcp:tools/list` or `mcp:tools/call` plus per-tool `mcp:tools/<name>:call` scopes that identity providers do not issue. Supporting it would need a configurable scope mapping and acceptance of provider subjects as owners. It would also change the guarantee from "signed by your LiteLLM" to "issued by your provider for this audience", making the provider's token-exchange policy the effective gateway restriction. Use the signer or forwarded credentials until that is designed. See [LiteLLM OBO auth](https://docs.litellm.ai/docs/mcp_obo_auth).

## 3. Run Markdownify

```sh
cp .env.jwt.example .env.jwt
# Edit issuer, audience, public JWKS URL and the public Markdownify origin.
docker compose -f compose.jwt.yaml up --build -d
```

PowerShell can use `Copy-Item .env.jwt.example .env.jwt`. Use this Compose file alone. It mounts only the private data volume, not credentials or signing keys. Run one process per volume. After this implementation is released, use `docker compose -f compose.jwt.yaml up -d --no-build --pull always` for the published image.

Configure HTTPS and preserve Authorization plus X-Upload-Token for `/mcp` and `/uploads/*`. Set `MD_PUBLIC_BASE_URL` to the reachable Markdownify origin and the appropriate Host allowlist. JWT mode cannot be combined with `MD_AUTH_FILE` or `MD_API_KEY`, including empty values. The original registry mode remains available for standalone use.

| Setting | Purpose |
| --- | --- |
| MD_JWT_ISSUER | Exact trusted issuer, matching LiteLLM signer |
| MD_JWT_AUDIENCE | Expected audience, recommended `markdownify` |
| MD_JWT_JWKS_URL | Pinned HTTPS public-key endpoint; token-supplied key URLs are ignored |
| MD_JWT_MAX_TTL_SECONDS | Maximum token lifetime/age; default 300, allowed 1–3600. Also bounds how long an already-issued token outlives LiteLLM revocation |
| MD_JWT_TOOL_PREFIX | Optional alias prefix accepted in tool scopes; default `markdownify-` |

Only RS256 is accepted. Issuer, audience, signature, expiration, issued-at, bounded lifetime, subject format and scopes are checked. JWKS requests have a five-second timeout, no redirect following, 256 KiB body cap, 60-second cache and five-second refresh cooldown. Key rotation is supported; cached public keys and issued JWTs are not instantly revoked. Avoid sharing virtual keys or service identities. `MD_JWT_ALLOW_HTTP_LOCALHOST=1` permits loopback-only JWKS HTTP for tests; keep it unset in remote deployments.

## 4. Configure agents and upload files

Clients connect to `https://litellm.example.com/markdownify/mcp` with their own LiteLLM virtual key. No Markdownify credential forwarding is needed.

Cursor `.cursor/mcp.json`:

```json
{"mcpServers":{"markdownify":{"url":"https://litellm.example.com/markdownify/mcp","headers":{"x-litellm-api-key":"Bearer ${env:LITELLM_API_KEY}"}}}}
```

Claude Code `.mcp.json`:

```json
{"mcpServers":{"markdownify":{"type":"http","url":"https://litellm.example.com/markdownify/mcp","headers":{"x-litellm-api-key":"Bearer ${LITELLM_API_KEY}"}}}}
```

Codex `~/.codex/config.toml`:

```toml
[mcp_servers.markdownify]
url = "https://litellm.example.com/markdownify/mcp"
env_http_headers = { "x-litellm-api-key" = "LITELLM_MCP_AUTH" }
```

Supply `LITELLM_MCP_AUTH` as `Bearer <this agent's LiteLLM virtual key>` in the client environment; keep tokens out of prompts and files. For VS Code, use the [README input-prompt example](../README.md#vs-code--github-copilot-local-extension-session) with the gateway URL and `x-litellm-api-key` header in place of Authorization.

Helper:

```sh
export MCP_URL=https://litellm.example.com/markdownify/mcp
export LITELLM_API_KEY='<this agent virtual key>'
export MARKDOWNIFY_BASE_URL=https://markdownify.example.com
# Leave MARKDOWNIFY_AGENT_TOKEN unset in JWT mode.
bun examples/upload-and-convert.ts report.pdf report.md
```

For binary uploads, `create_upload` returns a **separate scoped bearer** in `required_headers.Authorization`, plus X-Upload-Token. Use exactly those headers when streaming to the validated direct origin. Both credentials are hashed at rest, bound to one job/owner, consumed on successful PUT and expire after at most five minutes (or a shorter MD_UPLOAD_TTL_MS). A grant cannot authorize any MCP request (it is rejected with 401, including on initialization/ping), upload another job or retrieve any result. Treat these capabilities as secrets: possession of both grants authorizes that one upload, so never share/log them. This is not a gateway JWT token exchange or OAuth server.

Token refresh does not change ownership. Use normal finite polling, Unicode pagination and authorized cleanup from [SKILL.md](../SKILL.md). `AUTH_SCOPE_REQUIRED` means the operator must fix gateway scopes; do not forge claims or retry indefinitely. Expired upload grants require a new reservation.

## Verify the deployment

Check the public JWKS is reachable, then use two separate machine-user keys to convert real files. Cross-agent status/read/delete must return JOB_NOT_FOUND. A leaked X-Upload-Token combined with another job's scoped bearer must fail; grants must fail on MCP initialization, discovery and tool calls and on upload after successful upload/expiry; initialization/ping without an Authorization header remains public without granting ownership. Confirm fresh gateway tokens retain ownership, and bounded revocation behaves as documented. The repository's JWT tests and compiled-Node smoke cover protocol behavior; a live user gateway remains environment-specific verification.

For the direct-ownership model, also confirm in the live deployment:

- No subject map or allowlist is configured; ownership is the LiteLLM user ID. A key attached to no user (`litellm-proxy`) or a user ID outside `[A-Za-z0-9_-]{1,64}` is rejected.
- `get_service_health` for one user shows the effective caps from the table above (10 jobs, 128 MiB reserved, 1 active conversion by default) and that the operator's `MD_MAX_*` overrides in `.env.jwt` were applied to both the tenant and agent scopes.
- Blocking a test user's LiteLLM key stops new MCP calls through the gateway. Treat anything already issued as valid for up to `MD_JWT_MAX_TTL_SECONDS` (token) or five minutes (upload grant); do not expect immediate denial, and do not expect existing jobs to disappear before retention.
- The LiteLLM `ttl_seconds` does not exceed `MD_JWT_MAX_TTL_SECONDS`, and the signer and Markdownify clocks agree to within a few seconds.
- The deployed image is pinned by digest or commit-SHA tag rather than `latest`, one process runs against a private persistent `/data` volume, and the LiteLLM signing key is persistent (`MCP_JWT_SIGNING_KEY`), so a LiteLLM restart does not change the published JWKS.
- The signer's generated tool scopes allow list and call for the real agents, and a token without the needed scope returns `AUTH_SCOPE_REQUIRED`.
- Identity refresh and signing-key rotation: a fresh token for the same user ID still reaches that user's jobs, and after rotating the key (new key published, old key removed from the JWKS) tokens signed by the old key are rejected once the JWKS cache refreshes.
- Through the real gateway, convert real PDF and Office files (upload, `start_conversion`, finite status polling, paginated `get_markdown` retrieval). With a second user, foreign status, read, `start_conversion` and delete calls all return JOB_NOT_FOUND.
- Queued, interrupted and completed jobs across a Markdownify restart: queued jobs resume, running jobs become `failed` with `CONVERSION_INTERRUPTED` (`init()` in `src/remote/jobs.ts`), completed results stay retrievable, and retention cleanup runs.
- Record the Markdownify and LiteLLM versions, the image identity and sanitized evidence of these checks.

Client syntax references: [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code](https://code.claude.com/docs/en/mcp), [Cursor](https://cursor.com/docs/mcp). See [LiteLLM's auth matrix](https://docs.litellm.ai/docs/mcp_config_reference) for the separate gateway and upstream authentication layers.

## Health monitoring

LiteLLM 1.104 probes MCP initialization without a user. JWT mode permits only readiness-gated initialization/ping from requests with no Authorization header; a presented but invalid JWT gets 401 on every method, and all job tools and discovery still require a valid agent. Use GET /livez for liveness, GET /readyz for real process/storage/converter readiness, and authenticated get_service_health for private per-user metrics. See [health behavior and limits](HEALTH.md).
