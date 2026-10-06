# Single-tenant MVP validation

Validated locally on 2026-10-06 on Windows using Bun 1.4.2, Node 24.19.0, Python 3.12, MCP SDK 1.27.1, and MarkItDown 0.1.5. The container targets Node 22.

## Passed

GitHub Linux CI [run 37454606073](https://github.com/bxm156/markdownify-mcp/actions/runs/37454606073) completed successfully for implementation commit `f0475aba89bb5a7c884c231e8f64bd6ec086d60d`. It passed all 20 remote tests and 97 assertions, converted the real PDF and generated Office fixtures, built `Dockerfile.remote`, started the resulting Node 22 container, and verified authenticated MCP initialization/tool discovery, binary PDF upload, asynchronous conversion, paginated retrieval and deletion.

- Frozen-lockfile dependency installation with dependency scripts disabled.
- Portable TypeScript build: `bun run build:remote`.
- Remote suite: 20 tests, 97 assertions, zero failures.
- Authenticated stateless MCP SDK workflow across reconnects: reserve upload, direct streaming PUT, queue, poll, paginated retrieval and deletion.
- Invalid credentials/arguments/hosts/origins, upload overrun and undersize, interrupted upload retry, queue limits, converter output and time bounds, deletion/cancellation, expiration, restart recovery, and subprocess output handle closure.
- Real MarkItDown smoke: PDF fixture plus generated valid OOXML DOCX/XLSX/PPTX documents. Output includes expected format-specific text and Office parser verification text.
- Compiled Node server and runtime helper end to end with the real PDF.
- Runtime helper with a 136 KB output, three pages and non-BMP Unicode characters.
- Strict standalone TypeScript check of the example helper.
- Docker Compose configuration validation (with a temporary environment file).

The upstream DOCX/XLSX/PPTX sample files are 19-byte plain text, so the smoke test generates real Office packages instead of relying on their extensions.

## Limitations and remaining verification

- Upstream test suite: 68 passed, 11 repository-conversion tests failed because Windows cannot launch the existing Repomix executable resolution. Those legacy tools are unchanged and are not exposed by the remote service.
- Local Docker daemon access was blocked by the execution sandbox's named-pipe permissions, even after the user started Docker. Elevated Docker access was rejected by the configured permission policy. Container build/runtime verification passed in GitHub CI instead.
- Live LiteLLM integration and public TLS deployment are not yet tested: no host or gateway configuration/credentials were supplied.
- Single tenant, one process per private data directory. Every shared-key holder can access all jobs.
- Parser subprocesses have deadlines/output limits; resource and exploit isolation depend on deployment/container controls. No OCR or multi-tenant isolation is included.

## Reproduce

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build:remote
bun run test:remote
# Install the pinned MarkItDown extras and make Python/MarkItDown available.
bun run test:converter
```

See [remote deployment instructions](REMOTE.md) and [the milestone plan](../PLAN.md).

