# Agent errors and recovery

Use `lookup_error({"code":"FILE_TOO_LARGE"})` when an error code needs explanation. It returns static guidance without reading jobs or exposing other agents' usage. All seven remote tools describe when to call them and the next action.

MCP tool errors have `isError: true` and JSON text:

```json
{
  "error": "File exceeds upload limit",
  "error_info": {
    "code": "FILE_TOO_LARGE",
    "message": "File exceeds upload limit",
    "retryable": false,
    "next_steps": ["Reduce or split the document before reserving another upload."],
    "details": {"limit_bytes": 26214400, "requested_bytes": 30000000}
  }
}
```

This abbreviated example illustrates the shape; follow the actual returned next_steps. Upload errors use the same envelope with HTTP status. A status call itself succeeds for a failed conversion but returns `status: failed`, `error` and `error_info`: stop polling. Codes/details survive restart; old manifests without codes receive safe fallback guidance.

| Code | Recovery | Setting |
| --- | --- | --- |
| FILE_TOO_LARGE | Reduce/split input or ask operator; new reservation with actual size | MD_MAX_UPLOAD_BYTES |
| JOB_LIMIT_EXCEEDED | Authorized own-job deletion, retention expiry or operator | Global/tenant/agent job budget |
| STORAGE_LIMIT_EXCEEDED | Same cleanup; allow for input plus maximum output reservation | Global/tenant/agent storage budget |
| OUTPUT_LIMIT_EXCEEDED | Reduce/split input or adjust output cap; new upload | MD_MAX_OUTPUT_BYTES |
| CONVERSION_TIMEOUT | Reduce/split input or adjust timeout; new upload | MD_CONVERSION_TIMEOUT_MS |
| CONVERSION_INTERRUPTED | New upload after service recovers, bounded retries | Server restart |
| CONVERSION_FAILED | Check/repair source; give operator job ID/code | Parser diagnostics remain private |
| UPLOAD_SIZE_MISMATCH | Exact declared bytes on valid reservation, or new reservation | Actual vs declared size |
| UPLOAD_INTERRUPTED | Check state/expiry before bounded retry of PUT | MD_UPLOAD_TTL_MS |
| JOB_EXPIRED | New upload from original file | MD_RETENTION_MS |
| JOB_NOT_FOUND | Verify own ID/credential; never probe other owners | Foreign and missing responses are identical |
| MARKDOWN_NOT_READY | Check status; poll queued/running, follow failed-job guidance | Concurrency queues work |
| AUDIT_UNAVAILABLE / INTERNAL_ERROR | Operator recovery before retrying | Storage/permissions/service health |

Quota details contain configured `scope` and limits, never usage counts or other owners' IDs. `reserved_bytes` is the space required by the attempted upload, not total used storage. Unknown lookup codes return `UNKNOWN_ERROR_CODE` with `isError: true`. Request/schema/auth errors also carry guidance.

`retryable` never means unlimited or immediate retries. Follow next_steps with backoff and a deadline; quota failures require capacity to change. Delete only your own known unneeded jobs when authorized. Retain job IDs because there is no listing tool. Calling start_conversion again does not restart failed jobs.

See [SKILL.md](../SKILL.md). The helper renders locally known guidance and whitelisted numeric limits, without echoing arbitrary server/parser diagnostics.
