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
| M6: multiple tenants and private agents | Trusted identity propagation, tenant/agent ownership and quotas, isolated access, audit | Same-tenant and cross-tenant foreign access denied; container workflow passes |
| M7: scaling (deferred) | Transactional job database, shared queue/object storage, worker isolation, retries/monitoring | Multiple workers/replicas safely operate under failure |

Execution scope: M0-M4 delivered the first MVP; the user subsequently authorized M6 tenant and private-agent isolation, implemented in phase 2 below. M5 requires a hosting destination and LiteLLM instance/credentials, which have not been supplied. M7 scaling remains deferred. Record actual verification rather than claiming public deployment.

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

M0-M4 are complete and PR #1 is merged. [Linux CI run 37454606073](https://github.com/bxm156/markdownify-mcp/actions/runs/37454606073) passed the build, 20 remote tests/97 assertions, real PDF and generated Office conversions, container image build and authenticated container upload/conversion/retrieval/deletion workflow. See [MVP validation](docs/MVP-VALIDATION.md) for local results and limits. M5 (public hosting and live LiteLLM verification) remains pending. M6 implementation and verification are recorded in phase 2 below; M7 remains deferred.

## Phase 2: tenant and agent isolation

The user authorized M6 ahead of public deployment and explicitly chose **private files and results for every agent**, including agents belonging to the same tenant. A job is one uploaded file, its conversion state, and its Markdown result. Agent identities are stable across reconnects and credential rotation; an MCP connection is not an ownership boundary.

Implementation branch: `multi-tenant-agents`, based on merged PR #1 at `b8f99dce8bb8bb5749c4b700fc50eaf5047c97eb`.

Milestones for this phase:

1. Credential identity: operator-managed SHA-256 credential registry, separate tenant/agent identities, disabled credentials and rotation; reject ambiguous shared-key configuration.
2. Private operations: require both owner IDs before upload/start/status/Markdown/delete, including before cancellation and locks. Foreign and missing jobs return the same response. Upload PUT requires both active agent bearer credential and the scoped upload token.
3. Bounded resources: global, tenant and agent job/storage admission budgets, concurrency caps, and fair queue scheduling. Keep one process per data directory; distributed workers remain M7.
4. Audit and migration: metadata-only bounded audit logs; existing unowned jobs require one explicit operator-selected owner, with full startup validation before ownership changes.
5. PR #1 feedback: track the actual Copilot pagination issue in [issue #2](https://github.com/bxm156/markdownify-mcp/issues/2), replace full-result allocations with indexed bounded-memory pages, and close the issue when the fix merges.
6. Agent guidance: add repository `SKILL.md` with exact MCP arguments, runtime upload authentication, finite polling, code-point pagination, and private-agent constraints.
7. Validation and publication: unit/integration attacks from same-tenant and cross-tenant agents, restart/migration/quota/fairness checks, real documents, and three-agent workflow against the Docker image in Linux CI. Publish a reviewable PR; do not merge without user authorization.

M5 remains pending because a hosting destination and live LiteLLM environment have not been supplied. This phase proves application-level ownership for trusted parser/runtime deployment, not hostile-document parser sandboxing or distributed execution.

### Phase 2 verification

M6 implementation is complete in [PR #3](https://github.com/bxm156/markdownify-mcp/pull/3). [CI run 37456711823](https://github.com/bxm156/markdownify-mcp/actions/runs/37456711823) passed the portable build, 40 tests/272 assertions, real PDF and generated Office conversions, Docker image build, compatibility workflow, and three-agent same/cross-tenant isolation workflow against the running container. [Validation details](docs/MULTITENANT-VALIDATION.md) include local and container results. Issue #2 closes when PR #3 merges; the PR remains open for user review.

