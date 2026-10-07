# LiteLLM-signed JWT authentication (no Enterprise gateway auth)

Use a distinct LiteLLM machine user/virtual key per agent. LiteLLM authenticates that virtual key and signs the outgoing MCP request with a short-lived RS256 JWT. Markdownify verifies it against the configured public JWKS and maps the signed subject to one private tenant/agent identity. Clients need no long-lived Markdownify key.

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

Two keys attached to the same `user_id` intentionally resolve to the same agent, which supports key rotation. Different agents must have different user IDs and mappings. LiteLLM's stored upstream credentials also belong to user IDs, not individual keys. [Machine-user/key provisioning reference](https://docs.litellm.ai/docs/mcp_per_user_auth).

The signer generates `mcp:tools/list` and per-tool call scopes. Markdownify requires list scope for discovery, and both `mcp:tools/call` plus `mcp:tools/<name>:call` for execution. It also accepts a configured alias prefix (`markdownify-` by default). Leave scope auto-generation enabled; do not replace it with an unrelated generic scope. Verify your gateway injects JWTs for upstream initialization, discovery and execution; unsupported older gateway versions must be upgraded rather than weakening server checks.

## 2. Map JWT subjects to private agents

Create `secrets/jwt-principals.json`:

```json
{
  "principals": [
    {"subject":"markdownify-agent-a","tenant_id":"demo","agent_id":"agent-a"},
    {"subject":"markdownify-agent-b","tenant_id":"demo","agent_id":"agent-b"}
  ]
}
```

The subject must exactly match LiteLLM's verified `sub` claim. This allowlist is operator managed; caller headers, tool arguments, JWT `act`, email and tenant claims cannot override it. Unknown, disabled or the shared fallback `litellm-proxy` subject is rejected. Different mapped subjects may share a principal only for intentional identity rotation, never for independent agents.

The file contains no secrets, but restrict write access because it controls ownership. On Linux, make it readable by container group 10001, with its parent traversable:

```sh
sudo chgrp 10001 secrets secrets/jwt-principals.json
chmod 750 secrets
chmod 640 secrets/jwt-principals.json
```

For revocation, mark the entry `"disabled": true`, replace the file and recreate the container. Disable all aliases for the principal to revoke its outstanding upload grants. Map the same tenant/agent IDs to preserve existing completed-file ownership. Unfinished reservations created in registry mode cannot be uploaded in JWT mode: create a new reservation and clean up your own old reservation when authorized.

## 3. Run Markdownify

```sh
cp .env.jwt.example .env.jwt
# Edit issuer, audience, public JWKS URL and the public Markdownify origin.
docker compose -f compose.jwt.yaml up --build -d
```

PowerShell can use `Copy-Item .env.jwt.example .env.jwt`. Use this Compose file alone. It mounts the subject map and private data volume, not raw credentials or signing keys. Run one process per volume. After this implementation is released, use `docker compose -f compose.jwt.yaml up -d --no-build --pull always` for the published image.

Configure HTTPS and preserve Authorization plus X-Upload-Token for `/mcp` and `/uploads/*`. Set `MD_PUBLIC_BASE_URL` to the reachable Markdownify origin and the appropriate Host allowlist. JWT mode cannot be combined with `MD_AUTH_FILE` or `MD_API_KEY`, including empty values. The original registry mode remains available for standalone use.

| Setting | Purpose |
| --- | --- |
| MD_JWT_ISSUER | Exact trusted issuer, matching LiteLLM signer |
| MD_JWT_AUDIENCE | Expected audience, recommended `markdownify` |
| MD_JWT_JWKS_URL | Pinned HTTPS public-key endpoint; token-supplied key URLs are ignored |
| MD_JWT_PRINCIPALS_FILE | Operator subject-to-owner map |
| MD_JWT_MAX_TTL_SECONDS | Maximum token lifetime/age; default 300, allowed 1–3600 |
| MD_JWT_TOOL_PREFIX | Optional alias prefix accepted in tool scopes; default `markdownify-` |

Only RS256 is accepted. Issuer, audience, signature, expiration, issued-at, bounded lifetime, subject allowlist and scopes are checked. JWKS requests have a five-second timeout, no redirect following, 256 KiB body cap, 60-second cache and five-second refresh cooldown. Key rotation is supported; cached public keys and issued JWTs are not instantly revoked. Avoid sharing virtual keys or service identities. `MD_JWT_ALLOW_HTTP_LOCALHOST=1` permits loopback-only JWKS HTTP for tests; keep it unset in remote deployments.

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

For binary uploads, `create_upload` returns a **separate scoped bearer** in `required_headers.Authorization`, plus X-Upload-Token. Use exactly those headers when streaming to the validated direct origin. Both credentials are hashed at rest, bound to one job/owner, consumed on successful PUT and expire after at most five minutes (or a shorter MD_UPLOAD_TTL_MS). A grant cannot call MCP, upload another job or retrieve any result. Disabled owners are blocked after map reload. Treat these capabilities as secrets: possession of both grants authorizes that one upload, so never share/log them. This is not a gateway JWT token exchange or OAuth server.

Token refresh does not change ownership. Use normal finite polling, Unicode pagination and authorized cleanup from [SKILL.md](../SKILL.md). `AUTH_SCOPE_REQUIRED` means the operator must fix gateway scopes; do not forge claims or retry indefinitely. Expired upload grants require a new reservation.

## Verify the deployment

Check the public JWKS is reachable, then use two separate machine-user keys to convert real files. Cross-agent status/read/delete must return JOB_NOT_FOUND. A leaked X-Upload-Token combined with another job's scoped bearer must fail; grants must fail on MCP and after successful upload/expiry. Confirm fresh gateway tokens retain ownership, and restart/revocation work as intended. The repository's JWT tests and compiled-Node smoke cover protocol behavior; a live user gateway remains environment-specific verification.

Client syntax references: [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code](https://code.claude.com/docs/en/mcp), [Cursor](https://cursor.com/docs/mcp). See [LiteLLM's auth matrix](https://docs.litellm.ai/docs/mcp_config_reference) for the separate gateway and upstream authentication layers.
