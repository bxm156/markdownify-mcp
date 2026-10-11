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
| CONVERSION_INTERRUPTED | New upload after service recovers, bounded retries | Server restart (graceful or crash) |
| CONVERSION_CANCELLED | Stop polling; new upload only if still needed | Explicit cancellation |
| CONVERSION_FAILED | Check/repair source; give operator job ID/code | Parser diagnostics remain private |
| UPLOAD_SIZE_MISMATCH | Exact declared bytes on valid reservation, or new reservation | Actual vs declared size |
| UPLOAD_INTERRUPTED | Check state/expiry before bounded retry of PUT | MD_UPLOAD_TTL_MS |
| JOB_EXPIRED | New upload from original file | MD_RETENTION_MS |
| JOB_NOT_FOUND | Verify own ID/credential; never probe other owners | Foreign and missing responses are identical |
| MARKDOWN_NOT_READY | Check status; poll queued/running, follow failed-job guidance | Concurrency queues work |
| AUDIT_UNAVAILABLE / INTERNAL_ERROR | Operator recovery before retrying | Storage/permissions/service health |

Quota details contain configured `scope` and limits, never usage counts or other owners' IDs. For `scope: "agent"` the limit is the caller's own operator override when one is configured. `reserved_bytes` is the space required by the attempted upload, not total used storage. Unknown lookup codes return `UNKNOWN_ERROR_CODE` with `isError: true`. Request/schema/auth errors also carry guidance.

## Stopped conversions

A running conversion that is stopped before it finishes fails with one of three codes, chosen by why it was stopped:

| Code | Produced when | `retryable` |
| --- | --- | --- |
| CONVERSION_INTERRUPTED | The server stopped while the job was running. A graceful shutdown (SIGTERM, SIGINT or SIGHUP) stops the converter and records this code before the process exits. After a crash or SIGKILL, the next start finds the job still `running` and records the same code. | true |
| CONVERSION_TIMEOUT | The conversion ran longer than `MD_CONVERSION_TIMEOUT_MS`. `details.timeout_ms` reports the deadline. | false |
| CONVERSION_CANCELLED | The conversion was cancelled explicitly: `delete_job` on a running job. The job is removed right after, so its owner then sees `JOB_NOT_FOUND`. | false |

The first reason wins. A deadline that passes while a shutdown is already stopping the converter does not turn `CONVERSION_INTERRUPTED` into `CONVERSION_TIMEOUT`. A converter killed for any of these reasons is never reported as `CONVERSION_FAILED`, which is kept for documents the parser rejects.

If the server cannot save the `failed` state during a graceful shutdown, the saved state stays `running`, and the next start records `CONVERSION_INTERRUPTED` as after a crash.

## Unsaved failures

Starting a conversion first saves the job as `running`. If that write fails, the job fails with `INTERNAL_ERROR`, and the server also tries to save that `failed` state. If the second write fails too, the failure exists only in memory: status calls report `failed` until the process stops, but the saved state is still `queued`. After a restart the saved `queued` state wins and the job runs again. An agent that saw `failed` before the restart may therefore find the same job `queued`, `running` or `completed` afterwards. Check status again rather than treating the earlier failure as final.

## Retries

`retryable` never means unlimited or immediate retries. Follow next_steps with backoff and a deadline; quota failures require capacity to change. Delete only your own known unneeded jobs when authorized. Retain job IDs because there is no listing tool. Calling start_conversion again does not restart failed jobs.

See [SKILL.md](../SKILL.md). The helper renders locally known guidance and whitelisted numeric limits, without echoing arbitrary server/parser diagnostics.
