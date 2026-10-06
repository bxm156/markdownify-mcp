# Multi-tenant and private-agent validation

Implementation base: merged PR #1 (`b8f99dce8bb8bb5749c4b700fc50eaf5047c97eb`).

The access policy is immutable job ownership by `(tenant_id, agent_id)`. Another agent in the same tenant has no access. Credentials for the same identity intentionally share access to support rotation; operators must use different agent IDs for isolation.

## Local results

- Portable TypeScript build passed with Bun 1.4.2.
- Integrated remote tests: 56 passed, 415 assertions, zero failures (authentication, ownership, scoped uploads, quotas, scheduling, migration, audit, cancellation, restart and bounded Unicode pagination). The added tests exercise a killed worker process, concurrent start/provisioning, revocation and owner rotation across restart, expired quotas, atomic manifest failure, and audit filesystem recovery.
- Real PDF plus generated OOXML DOCX/XLSX/PPTX upload/conversion/retrieval smoke passed with MarkItDown 0.1.5.
- Three-credential workflow against the compiled Node service passed: agents A/B in one tenant and C in another; foreign PUT/start/status/read/delete denied, owner's jobs unaffected, successful private real-PDF conversions, reconnect and pagination.
- Operator credential-generation utility and streaming runtime helper passed against the real service. Hash verifiers matched generated credentials; audit log contained owner/denial metadata and excluded secrets/content.
- Strict TypeScript checks passed for the runtime helper, credential utility and multi-agent smoke script.
- Docker Compose multi-tenant configuration parses successfully.

## PR #1 feedback

PR #1 had one unresolved Copilot finding: every Markdown page loaded and expanded the full output. [Issue #2](https://github.com/bxm156/markdownify-mcp/issues/2) tracks the fix. A persisted sparse UTF-8 byte index now records total code points at conversion completion. Page reads seek near the requested offset and allocate memory proportional to the page, while retaining Unicode-safe offsets and restart cache reuse. Regression tests include a 10 MiB output, late-page reads, UTF-8 chunk boundaries, cache invalidation and malformed UTF-8.

## Deployment checks

[Linux CI run 37456711823](https://github.com/bxm156/markdownify-mcp/actions/runs/37456711823) passed for implementation commit `14c856fcf1c434b2176cf3c9db1b755bc873ba22`: portable build, 40 remote tests/272 assertions, real document conversions, Docker image build, compatibility upload workflow and the three-agent isolation workflow against the actual running container. The three-agent test covers private real-PDF conversion, cross-agent/cross-tenant denial for upload/start/status/read/delete, reconnects, pagination and own-job cleanup.

[PR CI run 37456769530](https://github.com/bxm156/markdownify-mcp/actions/runs/37456769530) independently passed all of those checks for the same implementation commit. Its completed container build and both container workflows confirm the result requested in PR #3's review. The expanded 56-test suite and updated runtime image are checked again on the new PR head; the above run describes the original implementation, not the new packaging.

Repository `SKILL.md` passed the bundled skill validator. A fresh agent with no implementation history used the skill and a provisioned runtime connection to convert the real PDF, save Markdown, retain its job, and independently retrieve the exact saved result. It reported no missing guidance. CI was used for container verification; no public service was deployed.

Live LiteLLM identity forwarding and public TLS hosting remain unverified without the user's deployment environment. Configuration instructions have been checked against the official LiteLLM reference via Firecrawl. Application quotas exclude bounded manifest/index/audit overhead and are not filesystem quotas. One service process per private data directory remains required.

## Reproduce

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build:remote
bun test src/remote
# Install the documented MarkItDown/Python extras.
bun scripts/remote-converter-smoke.ts
# Start the service using a registry for A/B (same tenant) and C (another tenant).
# Supply disposable raw keys through the runtime environment, never prompts/logs.
bun scripts/multitenant-http-smoke.ts
```

See [MULTITENANT.md](MULTITENANT.md) for provisioning and upgrades, and [the agent skill](../SKILL.md) for usage.
