---
name: markdownify-mcp
description: Convert agent-accessible files to Markdown using the remote Markdownify MCP service, including authenticated binary upload, conversion polling, private retrieval, and temporary job cleanup.
---

# Use Markdownify MCP

A job represents one uploaded file and its conversion result. Every job belongs to its authenticated tenant and agent; agents within the same tenant cannot share jobs. Credential rotation preserves jobs when the tenant and agent identity stays the same.

Use this skill when the user wants files converted through an available Markdownify MCP connection. Supported extensions are `.pdf`, `.docx`, `.xlsx`, `.pptx`, `.txt`, `.md`, `.csv`, `.html`, and `.json`. Conversion quality depends on the document; do not promise OCR for scanned PDFs.

## Connect and transfer bytes

Have the runtime supply this agent's credential; keep credentials out of prompts and logs. Direct MCP uses `Authorization: Bearer <agent credential>`. Through LiteLLM, use the configured gateway credentials and per-server authorization forwarding described in [multi-agent deployment](docs/MULTITENANT.md).

Discover available tool names with `listTools`; gateways may prefix names. Select the configured server rather than guessing among duplicate tools. Tool results place JSON in text content blocks: check `isError` first, then concatenate text blocks and parse JSON.

The model cannot transfer a file by naming its local path. The runtime must read and upload bytes. If the runtime cannot access the file or perform HTTP uploads, report that missing capability. Do not fabricate a completed upload, send base64 in tool arguments, or substitute another agent's credential.

## Convert a file

1. Reserve using `create_upload({"filename":"report.pdf","size_bytes":12345})`. Use the actual byte count and basename. The response contains `upload_id`, `upload_url`, `expires_at`, and `required_headers`.
2. Validate that the upload URL uses the configured Markdownify origin and HTTPS for remote hosts; local development may use loopback HTTP. Reject redirects and credential-bearing URLs. Stream the file with HTTP `PUT`, the returned `X-Upload-Token` and `Content-Type`, plus this agent's own `Authorization: Bearer <agent credential>`. Do not treat an HTTP failure as a successful upload.
3. Call `start_conversion({"upload_id":"<upload_id>"})`; retain its `job_id`. Upload and job IDs refer to the same file lifecycle.
4. Poll `get_conversion_status({"job_id":"<job_id>"})` with a finite deadline and backoff, for example 500 milliseconds increasing to 5 seconds. Continue through `queued` and `running`; stop on `failed` or `expired`.
5. When `completed`, call `get_markdown({"job_id":"<job_id>","offset":0,"max_chars":50000})`. Append `markdown`, then use returned `next_offset` until null. Offsets and `total_chars` count Unicode code points; do not calculate offsets from byte or JavaScript string lengths. `offset` is nonnegative; `max_chars` is 1–100000.
6. Call `delete_job({"job_id":"<job_id>"})` when cleanup is authorized and the result is safely saved. Keep the job when later retrieval is requested; temporary retention still applies.

HTTP 401 means authentication failed; 404 means unknown or unauthorized. Never probe using another credential. HTTP 409 means conflicting state or Markdown not ready; 410 means expired; 507 means capacity exhausted. MCP failures use `isError` with a message, not necessarily an HTTP status. Stop on audit unavailability or repeated failures; report a sanitized error and preserve useful job IDs.

## Runtime helper

Run `bun examples/upload-and-convert.ts input.docx output.md`. It preserves existing output files. Set `MCP_URL` and `MCP_TOKEN` for direct access. Gateway mode requires `LITELLM_API_KEY`, `MARKDOWNIFY_AGENT_TOKEN`, and `MARKDOWNIFY_BASE_URL`; `MARKDOWNIFY_SERVER_ALIAS` defaults to `markdownify`. The helper leaves remote jobs to expire automatically.

See [the streaming helper](examples/upload-and-convert.ts), [remote deployment](docs/REMOTE.md), and [multi-agent configuration](docs/MULTITENANT.md) for runtime setup.
