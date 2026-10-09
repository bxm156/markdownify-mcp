type Guidance = { message: string; retryable: boolean; next_steps: string[] };
const catalog = {
  AUTH_SCOPE_REQUIRED: { message: "Scope not granted", retryable: false, next_steps: ["Ask the gateway/operator to grant this tool's scope to your agent. Do not edit or forge JWT claims; refresh through the configured signer after authorization changes."] },
  FILE_TOO_LARGE: { message: "File exceeds upload limit", retryable: false, next_steps: ["Reduce or split the document to fit details.limit_bytes, then create_upload with its actual byte count.", "Ask the operator to raise MD_MAX_UPLOAD_BYTES if required; do not retry the unchanged file."] },
  JOB_LIMIT_EXCEEDED: { message: "Temporary job capacity exhausted", retryable: false, next_steps: ["Delete only your own unneeded jobs with delete_job when cleanup is authorized, or wait for retention expiry.", "Retry create_upload only after capacity is available; ask the operator if the reported scope remains full."] },
  STORAGE_LIMIT_EXCEEDED: { message: "Temporary storage capacity exhausted", retryable: false, next_steps: ["Delete only your own unneeded jobs when authorized, or wait for expiry before retrying create_upload.", "Each job reserves input bytes plus the maximum output bytes. A smaller file may still not fit. Ask the operator to adjust the reported scope's storage budget."] },
  OUTPUT_LIMIT_EXCEEDED: { message: "Converted Markdown exceeds output limit", retryable: false, next_steps: ["Stop polling this failed job; start_conversion does not restart failed jobs.", "Reduce or split the source and create a new upload, or ask the operator to raise MD_MAX_OUTPUT_BYTES. Save the job ID before authorized cleanup."] },
  CONVERSION_TIMEOUT: { message: "Conversion timed out", retryable: false, next_steps: ["Stop polling this failed job. Reduce or split the source, or ask the operator to raise MD_CONVERSION_TIMEOUT_MS.", "Use a new upload for another attempt; start_conversion does not restart a failed job."] },
  CONVERSION_CANCELLED: { message: "Conversion cancelled", retryable: false, next_steps: ["Stop polling. If conversion is still needed, create a new upload after confirming the service is available."] },
  CONVERSION_INTERRUPTED: { message: "Conversion interrupted by server restart", retryable: true, next_steps: ["After the service recovers, create a new upload and convert again with bounded retries. Failed jobs cannot be restarted with start_conversion."] },
  CONVERSION_FAILED: { message: "Document conversion failed", retryable: false, next_steps: ["Stop polling; check that the file is valid and supported. Do not repeatedly submit the unchanged document.", "Try a repaired or simpler document as a new upload, or give the job ID and error code to the operator. Parser diagnostics are not exposed."] },
  JOB_NOT_FOUND: { message: "Job not found", retryable: false, next_steps: ["Check the saved job ID and your own agent credential. Never try another agent's credential or probe IDs.", "If your job was removed, create a new upload from the original file."] },
  JOB_EXPIRED: { message: "Job expired", retryable: false, next_steps: ["The file/result is no longer available. Create a new upload from the original file if needed."] },
  UPLOAD_SIZE_MISMATCH: { message: "Upload size does not match declared size", retryable: false, next_steps: ["Recheck the file's actual byte count. Retry the existing reservation only with exactly its declared bytes while it remains valid; otherwise create a new reservation."] },
  UPLOAD_INTERRUPTED: { message: "Upload cancelled or timed out", retryable: true, next_steps: ["Check get_conversion_status first. Retry PUT only if awaiting_upload and the reservation is still valid; otherwise create_upload again.", "Use bounded retries with backoff. Do not start_conversion until PUT succeeds."] },
  UPLOAD_IN_PROGRESS: { message: "Upload already in progress", retryable: true, next_steps: ["Wait for the existing PUT; do not upload concurrently to the same reservation. Check status before retrying."] },
  UPLOAD_ALREADY_COMPLETED: { message: "Upload already consumed", retryable: false, next_steps: ["Check get_conversion_status. If uploaded, call start_conversion; do not PUT again."] },
  UPLOAD_INCOMPLETE: { message: "File upload is incomplete", retryable: false, next_steps: ["Finish the binary PUT with the owner credential and scoped upload token before calling start_conversion."] },
  MARKDOWN_NOT_READY: { message: "Markdown is not ready", retryable: true, next_steps: ["Call get_conversion_status. If uploaded, start_conversion; if queued/running, poll with backoff and a finite deadline. If failed, follow error_info instead."] },
  INVALID_ARGUMENTS: { message: "Invalid tool arguments", retryable: false, next_steps: ["Read the tool's input schema and correct arguments before retrying. Do not send local paths or base64 as file content."] },
  UNSUPPORTED_FORMAT: { message: "Unsupported file format", retryable: false, next_steps: ["Use PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, HTML or JSON. Convert the source to a supported format before creating a new upload."] },
  INVALID_PAGINATION: { message: "Invalid pagination parameters", retryable: false, next_steps: ["Use nonnegative offset and max_chars from 1 to 100000. Follow the returned next_offset; offsets count Unicode code points."] },
  AUTH_REQUIRED: { message: "Authorization required", retryable: false, next_steps: ["Have the runtime/operator supply this agent's active credential or gateway-issued JWT. Never substitute another agent's identity. In registry or single-key (MD_API_KEY) mode, credential changes require a server restart because they are read once at startup; in JWT mode, access is managed in LiteLLM and revocation is bounded by token and upload-grant expiry.", "For expired scoped upload credentials, create a fresh reservation from the original file and use its returned headers. Delete only your own unneeded reservation when cleanup is authorized."] },
  AUDIT_UNAVAILABLE: { message: "Audit unavailable", retryable: false, next_steps: ["Stop operations and notify the operator to restore audit storage/permissions. Retry only after recovery; do not bypass auditing."] },
  SERVICE_UNAVAILABLE: { message: "Service closing", retryable: true, next_steps: ["Wait for service recovery, then retry with bounded backoff. Check status before repeating an upload or conversion."] },
  UNKNOWN_TOOL: { message: "Unknown tool", retryable: false, next_steps: ["Discover available tools with listTools; gateways may prefix names."] },
  UNKNOWN_ERROR_CODE: { message: "Unknown error code", retryable: false, next_steps: ["Use the exact error_info.code returned by this server. If unavailable, report the sanitized error and job ID to the operator."] },
  REQUEST_REJECTED: { message: "Request rejected", retryable: false, next_steps: ["Check the response message, endpoint, method, content type, host/origin and body size. Correct the request or ask the operator; do not bypass host/auth checks."] },
  INTERNAL_ERROR: { message: "Operation failed", retryable: false, next_steps: ["Preserve the job ID and report the error to the operator. Check status after recovery before repeating operations; avoid blind retries."] },
} satisfies Record<string, Guidance>;
export type ErrorCode = keyof typeof catalog;
export type ErrorDetails = { scope?: "global" | "tenant" | "agent"; limit_bytes?: number; requested_bytes?: number; reserved_bytes?: number; limit_jobs?: number; timeout_ms?: number };
export type ErrorInfo = Guidance & { code: ErrorCode; details?: ErrorDetails };
export function lookupError(code: string): ErrorInfo {
  const known = Object.hasOwn(catalog, code) ? code as ErrorCode : "UNKNOWN_ERROR_CODE";
  const entry = catalog[known];
  return { code: known, message: entry.message, retryable: entry.retryable, next_steps: [...entry.next_steps] };
}
const legacy: Record<string, ErrorCode> = {
  "Job not found": "JOB_NOT_FOUND", "Job expired": "JOB_EXPIRED", "Invalid principal": "AUTH_REQUIRED", "Authorization required": "AUTH_REQUIRED",
  "Audit unavailable": "AUDIT_UNAVAILABLE", "Service closing": "SERVICE_UNAVAILABLE", "Invalid filename": "INVALID_ARGUMENTS", "Invalid or excessive file size": "INVALID_ARGUMENTS",
  "Unsupported file format": "UNSUPPORTED_FORMAT", "Upload exceeds declared size": "UPLOAD_SIZE_MISMATCH", "Upload size does not match declared size": "UPLOAD_SIZE_MISMATCH",
  "Upload cancelled or timed out": "UPLOAD_INTERRUPTED", "Upload already in progress": "UPLOAD_IN_PROGRESS", "Upload already consumed": "UPLOAD_ALREADY_COMPLETED",
  "File upload is incomplete": "UPLOAD_INCOMPLETE", "Markdown is not ready": "MARKDOWN_NOT_READY", "Invalid pagination parameters": "INVALID_PAGINATION", "Offset exceeds Markdown length": "INVALID_PAGINATION",
  "Conversion interrupted by server restart": "CONVERSION_INTERRUPTED", "Conversion cancelled or timed out": "CONVERSION_TIMEOUT", "Document conversion failed": "CONVERSION_FAILED",
};
export function legacyCode(message: string): ErrorCode { return legacy[message] ?? "INTERNAL_ERROR"; }
export class ServiceError extends Error {
  constructor(public statusCode: number, message: string, public code: ErrorCode = legacyCode(message), public details?: ErrorDetails) { super(message); }
}
export function errorInfo(error: unknown): ErrorInfo {
  if (!(error instanceof ServiceError)) return lookupError("INTERNAL_ERROR");
  return { ...lookupError(error.code), message: error.message, ...(error.details ? { details: error.details } : {}) };
}
export function errorResponse(error: unknown) {
  const info = errorInfo(error);
  return { error: info.message, error_info: info };
}
