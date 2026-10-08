---
name: markdownify-mcp
description: Convert agent-accessible files to Markdown using the remote Markdownify MCP service, including authenticated binary upload, conversion polling, private retrieval, and temporary job cleanup.
---

# Use Markdownify MCP

A job represents one uploaded file and its conversion result. Every job belongs to its authenticated tenant and agent; agents within the same tenant cannot share jobs. Credential rotation preserves jobs when the tenant and agent identity stays the same.

Use this skill when the user wants files converted through an available Markdownify MCP connection. Supported extensions are `.pdf`, `.docx`, `.xlsx`, `.pptx`, `.txt`, `.md`, `.csv`, `.html`, and `.json`. Conversion quality depends on the document; do not promise OCR for scanned PDFs.

## Connect and transfer bytes

Have the runtime supply this agent's credential; keep credentials out of prompts and logs. Direct MCP uses `Authorization: Bearer <agent credential>`. Through LiteLLM, use the configured gateway credentials and per-server authorization forwarding described in [multi-agent deployment](docs/MULTITENANT.md).

In recommended [LiteLLM JWT mode](docs/JWT.md), the runtime supplies only its own LiteLLM virtual key; LiteLLM signs MCP requests automatically. No Markdownify long-lived key or per-server credential forwarding is needed. Identity is mapped from the verified JWT subject, never selected by tool arguments. The upload response includes a separate short-lived Authorization header: use it together with X-Upload-Token for that job only. Never substitute the gateway key or a JWT for this scoped upload credential. Neither returned credential authorizes MCP discovery/tool calls or upload after success/expiry. Public initialization/ping may succeed without granting file access.

Discover available tool names with `listTools`; gateways may prefix names. Select the configured server rather than guessing among duplicate tools. Tool results place JSON in text content blocks: check `isError` first, then concatenate text blocks and parse JSON.

The model cannot transfer a file by naming its local path. The runtime must read and upload bytes. If the runtime cannot access the file or perform HTTP uploads, report that missing capability. Do not fabricate a completed upload, send base64 in tool arguments, or substitute another agent's credential.

## Check readiness

Use get_service_health({}) with your normal identity to inspect readiness, your own job states/reserved bytes and configured limits. Queued work or a full quota is capacity pressure, not a failed process. Anonymous initialization/ping is monitoring only and never authorizes job tools; keep using normal authentication. See [health reference](docs/HEALTH.md).

## Convert a file

1. Reserve using `create_upload({"filename":"report.pdf","size_bytes":12345})`. Use the actual byte count and basename. The response contains `upload_id`, `upload_url`, `expires_at`, and `required_headers`.
2. Validate that the upload URL uses the configured Markdownify origin and HTTPS for remote hosts; local development may use loopback HTTP. Reject redirects and credential-bearing URLs. Stream the file with HTTP `PUT` and returned headers. If required_headers contains Authorization, use that scoped bearer unchanged; otherwise registry mode requires the runtime's own agent bearer credential. Do not treat an HTTP failure as a successful upload. Expired scoped grants require a new reservation.
3. Call `start_conversion({"upload_id":"<upload_id>"})`; retain its `job_id`. Upload and job IDs refer to the same file lifecycle.
4. Poll `get_conversion_status({"job_id":"<job_id>"})` with a finite deadline and backoff, for example 500 milliseconds increasing to 5 seconds. Continue through `queued` and `running`; stop on `failed` or `expired`.
5. When `completed`, call `get_markdown({"job_id":"<job_id>","offset":0,"max_chars":50000})`. Append `markdown`, then use returned `next_offset` until null. Offsets and `total_chars` count Unicode code points; do not calculate offsets from byte or JavaScript string lengths. `offset` is nonnegative; `max_chars` is 1–100000.
6. Call `delete_job({"job_id":"<job_id>"})` when cleanup is authorized and the result is safely saved. Keep the job when later retrieval is requested; temporary retention still applies.

HTTP 401 means authentication failed; 404 means unknown or unauthorized. Never probe using another credential. HTTP 409 means conflicting state or Markdown not ready; 410 means expired; 507 means capacity exhausted. MCP failures use `isError` with a message, not necessarily an HTTP status. Stop on audit unavailability or repeated failures; report a sanitized error and preserve useful job IDs.

## Recover from errors

Tool failures (`isError: true`) contain JSON text with `error` and `error_info`. HTTP upload errors use the same body. A successful status call may report `status: failed` with `error_info`; that is a terminal conversion failure, so stop polling. `error_info` contains `code`, `message`, `retryable`, `next_steps`, and optional numeric/configured `details`.

Call `lookup_error({"code":"OUTPUT_LIMIT_EXCEEDED"})` for code meanings and recovery steps. This lookup is static: use the original error's `details` for actual limits. Unknown codes return `UNKNOWN_ERROR_CODE`, not guessed guidance. `retryable: true` permits a bounded retry only after the stated preconditions; `false` requires changed input, capacity or operator intervention. Never loop indefinitely or change another agent's credentials.

- `FILE_TOO_LARGE`: reduce/split the file to `details.limit_bytes`; recompute its byte count before a new reservation.
- `JOB_LIMIT_EXCEEDED` / `STORAGE_LIMIT_EXCEEDED`: delete only your own known unneeded jobs when authorized, wait for retention expiry, or ask the operator about the reported scope. A storage reservation includes input plus maximum output; no other agent's usage is exposed.
- `UPLOAD_SIZE_MISMATCH`: send exactly the declared bytes to a still-valid awaiting-upload reservation, or reserve the corrected file again. After an interruption, check status before retrying PUT.
- `OUTPUT_LIMIT_EXCEEDED` / `CONVERSION_TIMEOUT`: stop polling, reduce/split the source or ask the operator to change the relevant limit. Submit a new upload for another attempt; `start_conversion` does not restart failed jobs.
- `CONVERSION_INTERRUPTED`: after service recovery, create a new upload with bounded retries. `CONVERSION_FAILED` does not disclose parser stderr; check the document and report the code/job ID to the operator.
- `MARKDOWN_NOT_READY`: check status, start an uploaded job if needed, or poll queued/running work with a finite deadline. Concurrency caps queue work; they are not errors requiring new jobs.
- `AUDIT_UNAVAILABLE`, authentication and unexpected internal failures: stop and involve the operator; preserve IDs and sanitized codes, never credentials or raw document diagnostics.

See [error reference](docs/ERRORS.md) for response examples and limits. The runtime helper prints known recovery guidance and numeric limits without echoing arbitrary server diagnostics.

## Runtime helper

Run `bun examples/upload-and-convert.ts input.docx output.md`. It preserves existing output files. Set `MCP_URL` and `MCP_TOKEN` for direct access. JWT gateway mode requires `LITELLM_API_KEY` and `MARKDOWNIFY_BASE_URL`; registry gateway mode also requires `MARKDOWNIFY_AGENT_TOKEN`. `MARKDOWNIFY_SERVER_ALIAS` defaults to `markdownify`. The helper honors returned scoped upload Authorization and leaves jobs to expire automatically.

See [the streaming helper](examples/upload-and-convert.ts), [remote deployment](docs/REMOTE.md), and [multi-agent configuration](docs/MULTITENANT.md) for runtime setup.
