# Remote Markdownify: milestones and single-tenant MVP

Date: 2026-10-06
Fork: https://github.com/bxm156/markdownify-mcp
Upstream baseline: 024f97cea9a94cd842c445eea4503c442c79bd71
Implementation branch: remote-upload-mvp

## Goal and acceptance contract

An agent runtime uploads a local document directly to the hosted service, starts an asynchronous conversion through MCP, checks status later (including from another connection), and retrieves Markdown in bounded pages. The first MVP serves a single trusted tenant with a shared bearer credential. Multiple independent users must not treat it as isolated storage.

The model chooses actions; the runtime reads file bytes and performs the upload. Large binaries and base64 must not pass through model context. Native Streamable HTTP exposes /mcp; raw PUT /uploads/{id} handles binary streaming using a short-lived upload credential. LiteLLM routes MCP calls but does not proxy this binary upload endpoint.

## Architectural decisions

- Reuse MarkItDown as the conversion engine; keep upstream stdio tools intact.
- Expose only upload/job tools remotely; no arbitrary paths, repository fetching, or remote URL conversion.
- One application process, bounded in-process worker queue, one replica.
- Atomic JSON job manifests and separate generated input/output paths in a private persistent volume. This replaces the earlier SQLite suggestion for the MVP, avoiding an extra native dependency while retaining restart recovery. A transactional shared queue/database is a later milestone.
- Short-lived one-use upload tokens (only hashes persisted), UUID identifiers, exact declared upload sizes, supported extension allowlist, global storage/job limits.
- Results survive connection changes; queued jobs resume on restart and interrupted running jobs fail clearly. Retention deletes data; explicit deletion supported.
- Parser execution bounded by time, output bytes, and worker count; deploy non-root with limited filesystem/network access.
- Shared service authentication does not provide tenant identity.

## Milestones

| Milestone | Deliverables | Exit criteria |
| --- | --- | --- |
| M0: repository and contract | Fork, this plan, implementation branch, explicit scope | Fork verified and plan committed |
| M1: upload and job storage | Streaming upload, private temporary directory, durable manifests, quota reservation, expiration | Tests cover exact size, oversize, invalid ID/name/token, duplicate upload, restart and cleanup |
| M2: background conversion | MarkItDown subprocess adapter, queue, timeout/abort, saved Markdown, status and pagination | Real sample PDF/DOCX/XLSX/PPTX conversions succeed; converter failures/timeouts are reported; jobs survive connection changes |
| M3: remote MCP | Native HTTP transport, bearer auth, create_upload/start_conversion/get_conversion_status/get_markdown/delete_job | SDK client completes upload -> start -> poll -> retrieve; auth/validation tests pass |
| M4: first MVP packaging | Docker/Compose, environment template, agent helper, LiteLLM example, CI, operational documentation | Portable build and remote test suite pass; deployment and LiteLLM setup are documented; source published in the fork |
| M5: deployment verification | Deploy to a selected host, configure TLS/volume/secrets/LiteLLM | Real agent through the user's LiteLLM uploads and retrieves a document; cleanup and restart observed |
| M6: multiple tenants (deferred) | Trusted identity propagation, tenant ownership/quotas, isolated access, audit | Cross-tenant access denied in tests |
| M7: scaling (deferred) | Transactional job database, shared queue/object storage, worker isolation, retries/monitoring | Multiple workers/replicas safely operate under failure |

Execution target for this task: M0-M4. M5 requires a hosting destination and LiteLLM instance/credentials, which have not been supplied. Record its actual verification state rather than claiming deployment. M6-M7 are explicitly out of scope.

## Agent work split

1. Storage/conversion agent: JobService, subprocess converter, durable lifecycle and unit tests.
2. HTTP/MCP agent: Streamable HTTP transport, authentication, input validation and integration tests.
3. Deployment agent: container packaging, runtime upload helper, LiteLLM config and CI.
4. Coordinator: configuration/startup, this plan, dependency setup, integration, real fixture tests, review, publication.

## Public API

- create_upload(filename, size_bytes): returns upload_id, upload_url, headers and expires_at.
- PUT upload_url with returned headers and raw bytes: completes the upload; no conversion is started yet.
- start_conversion(upload_id): returns job_id and current status, promptly and idempotently.
- get_conversion_status(job_id): returns status and safe error information.
- get_markdown(job_id, offset?, max_chars?): bounded text, next_offset and total_chars.
- delete_job(job_id): removes artifacts, stopping active work before deletion.

States: awaiting_upload -> uploaded -> queued -> running -> completed / failed; expired artifacts become unavailable.

## Initial defaults

25 MiB per upload; 256 MiB total reserved storage; 100 jobs; 25 MiB maximum Markdown; two converter workers; 120-second conversion timeout; 15-minute upload token; 24-hour retention. These are configurable starting points, not measured throughput guarantees.

## Validation and release gate

- Build the existing project with a portable TypeScript command.
- Run existing tests where prerequisites are available and the new focused remote tests.
- Exercise success plus auth failures, malformed arguments, missing/invalid jobs, upload size mismatch, concurrent uploads, quota exhaustion, expiration, restart and converter failure.
- Run the real MarkItDown adapter against the repository's PDF, DOCX, XLSX and PPTX fixtures.
- Review container configuration and CI; only claim Docker execution or live LiteLLM connectivity if actually run.
- Publish implementation and test results on the fork, with a reviewable PR and exact limitations.

## Sources checked with Firecrawl

- https://docs.litellm.ai/docs/mcp_config_reference : upstream transport http and bearer_token; client gateway authentication is separate.
- https://github.com/zcaceres/markdownify-mcp : current upstream source and local-path tool behavior.
- https://github.com/microsoft/markitdown : supported formats and conversion/security considerations.
- https://github.com/supercorp-ai/supergateway : transport bridging alternative. Native HTTP chosen because uploads and job lifecycle already require an HTTP service.

## Verification status

Implementation and test results will be recorded in docs/MVP-VALIDATION.md before publication.
