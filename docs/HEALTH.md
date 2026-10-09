# Health checks and LiteLLM 1.104

LiteLLM 1.104.0's MCPServerManager.health_check_server opens an MCPClient session with static headers and no user identity. Its callback is a no-op; successful MCP initialization is marked healthy. It does not call /readyz or fetch detailed health metrics. The per-user signer is not part of this health path.

Source: [LiteLLM 1.104 manager](https://github.com/BerriAI/litellm/blob/10444df3a0173a99ab4e4858ce6777f31530e6c5/litellm/proxy/_experimental/mcp_server/mcp_server_manager.py). The integration test uses the actual installed 1.104.0 MCPClient.run_with_session path.

## Public readiness and restricted MCP probes

GET /livez (alias /healthz) returns 200 `{"status":"ok"}` whenever the process is serving; point container HEALTHCHECK and liveness probes here so a full disk does not cause restart loops. GET /readyz returns HTTP 200 only after initialization, while accepting work, with writable storage/free space and an available converter executable. Otherwise it returns 503. Its public body contains only status, ready and boolean checks (initialized, accepting_work, storage.writable, converter.available); free space, memory, uptime and check time are reserved for get_service_health. An in-flight check is shared by concurrent requests; completed checks are cached for two seconds after they settle; storage is tested with a small write/delete probe and statfs. Converter availability means an executable file was found (and is executable on Unix), not that all Python dependencies or document conversions work. Custom test converters are reported as custom.

In JWT mode only, requests with no Authorization header may perform initialize, notifications/initialized and ping on /mcp. They are gated by the same readiness check and receive no owner, tool capabilities or authenticated access. Any request carrying an Authorization header is verified first: a missing-sub, expired or otherwise invalid JWT, or an upload grant, is rejected with 401 and `WWW-Authenticate: Bearer` on every method, including initialize and ping, so a broken JWKS, issuer or audience setup does not look healthy. Batch requests and all other methods still require authentication. Tools/list, tools/call, resources and prompts remain protected. Registry mode continues requiring authentication for MCP probes.

Keep Host/Origin checks and TLS enabled. No shared health principal, fallback user, long-lived monitoring key or job ownership is created. Public probes expose only the readiness verdict, not user identities, job counts, reservations, capacity metrics, paths or errors.

## Private agent metrics

Use get_service_health({}) with the normal authenticated agent and its per-tool JWT scope. It returns detailed readiness (checked_at, uptime_seconds, memory_rss_bytes, storage free_bytes) plus:

- own_jobs: counts for the caller's job states, including retained expired tombstones.
- own_reserved_bytes: the caller's current input-plus-maximum-output reservation, using the same non-expired-state accounting as admission.
- limits: configured global/tenant/agent job, storage and concurrency caps, and per-file/output limits.
- cleanup: service-wide retention sweep counters: last_started_at, last_finished_at, last_duration_ms, jobs_failed_last_sweep, failures_total, consecutive_failed_sweeps, last_failure_at and last_error_code (an errno-style code such as EACCES). They contain no identities, job IDs, paths or messages. Cleanup failures do not fail readiness; alert on consecutive_failed_sweeps above zero and see [MULTITENANT.md](MULTITENANT.md#inspecting-and-purging-a-retired-users-artifacts).

There is no foreign-user usage, job ID or tenant list. Global limits are configuration, not global usage. When JWT tenant and agent IDs both equal the user ID, both caps constrain that user. A full quota or queued work is normal capacity pressure and does not make readiness fail. Quotas exclude metadata/index/audit overhead; disk free space is a filesystem metric, not reserved storage.

This check does not inspect LiteLLM admission, JWT signing configuration, public TLS, audit health, parser quality or end-to-end conversion success. Use real conversion/isolated-agent tests for those checks.

## Reproduce the upstream probe locally

Build the server and make MarkItDown available on PATH or set MARKITDOWN_PATH, then use an isolated Python environment:

```sh
bun run build:remote
python -m pip install 'litellm[mcp]==1.104.0'
python scripts/litellm-health-smoke.py
```

The test starts a compiled Node JWT-mode service and runs LiteLLM's real `MCPClient.run_with_session` initialization path anonymously. It additionally sends `ping`, so it is a superset of LiteLLM's no-op health callback (which only initializes). It then checks real readiness and confirms anonymous discovery is rejected with a real HTTP 401 status error from LiteLLM's httpx2 client (a timeout, transport error or any other status fails the test; message text is never matched). The script first runs a built-in regression self-test of that classifier; `python scripts/litellm-health-smoke.py --self-test` runs only that part. It supplies no user token and does not contact a real gateway. CI runs this alongside authenticated conversion and isolation checks.
