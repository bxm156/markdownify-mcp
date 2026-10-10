import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { JobService, ServiceError } from "./jobs.js";
import type { AuthenticatedPrincipal } from "./auth.js";
import { errorResponse, lookupError } from "./errors.js";

export const SERVER_INFO = { name: "markdownify-remote", version: "0.1.0" } as const;
const id = z.string().uuid();
const definitions = {
  get_service_health: { description: "Use to check service readiness, storage/converter checks, and your own job states, reserved bytes, configured quota/concurrency limits and limits.effective (the tightest caps that apply to you, including any operator override for you). Never returns other users' job counts, usage or IDs. Queue saturation is normal and does not make the process unhealthy. This is not a converter quality test; follow existing error guidance on failures.", schema: z.strictObject({}) },
  create_upload: { description: "Use first for a new accessible file or replacement of an expired/failed job. Reserve private storage using basename and actual byte count. Runtime must PUT bytes to upload_url with required_headers: use returned scoped Authorization in JWT mode, otherwise add owner bearer Authorization. Files do not pass through MCP. Keep both upload credentials secret; grants expire and are consumed once. Follow error_info/lookup_error on limits; avoid blind retries and duplicate reservations.", schema: z.strictObject({ filename: z.string().min(1).max(255), size_bytes: z.number().int().positive() }) },
  start_conversion: { description: "Use only after the binary PUT succeeds. Queue your uploaded file and return promptly. Repeated calls are idempotent; failed jobs are not restarted. Poll get_conversion_status next. Concurrency limits queue work; do not create duplicate jobs.", schema: z.strictObject({ upload_id: id }) },
  get_conversion_status: { description: "Use to resume a saved job or poll after start_conversion with backoff and a finite deadline. For completed, call get_markdown. For failed, stop polling and follow error_info.next_steps or lookup_error(error_info.code). Only your own jobs are accessible.", schema: z.strictObject({ job_id: id }) },
  get_markdown: { description: "Use only when get_conversion_status says completed. Retrieve bounded pages; append markdown and follow next_offset until null. Offsets count Unicode code points, not bytes/string length. Save the result before authorized cleanup; expired results need a new upload.", schema: z.strictObject({ job_id: id, offset: z.number().int().nonnegative().optional(), max_chars: z.number().int().min(1).max(100000).optional() }) },
  delete_job: { description: "Use for authorized cleanup of your own unneeded job after saving results, or to free quota. Permanently removes input/result and cancels active work. Retain jobs needed for later retrieval; never delete another agent's files. No job-listing tool exists: retain IDs you create.", schema: z.strictObject({ job_id: id }) },
  lookup_error: { description: "Use when a tool, upload response or failed status returns error_info.code and you need recovery guidance. Returns the code's meaning, retryable flag and next_steps. This static lookup does not inspect jobs or reveal credentials/other-agent usage; instance-specific limits are in the original error_info.details. retryable never means unlimited retries.", schema: z.strictObject({ code: z.string().min(1).max(64) }) },
};

export function createRemoteServer(service: JobService, publicBaseUrl: string, principal: AuthenticatedPrincipal): Server {
  const base = publicBaseUrl.replace(/\/$/, "");
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (principal.scopes && !principal.scopes.includes("mcp:tools/list")) throw new ServiceError(403, "Scope not granted", "AUTH_SCOPE_REQUIRED");
    return { tools: Object.entries(definitions).map(([name, definition]) => ({ name, description: definition.description, inputSchema: z.toJSONSchema(definition.schema) as any })) };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const definition = Object.hasOwn(definitions, params.name) ? definitions[params.name as keyof typeof definitions] : undefined;
      if (!definition) throw new ServiceError(400, "Unknown tool", "UNKNOWN_TOOL");
      if (principal.scopes && (!principal.scopes.includes("mcp:tools/call") || ![params.name, `${principal.toolPrefix ?? "markdownify-"}${params.name}`].some(name => principal.scopes!.includes(`mcp:tools/${name}:call`)))) throw new ServiceError(403, "Scope not granted", "AUTH_SCOPE_REQUIRED");
      const parsed = definition.schema.safeParse(params.arguments ?? {});
      if (!parsed.success) throw new ServiceError(400, "Invalid tool arguments", "INVALID_ARGUMENTS");
      const args = parsed.data as any;
      let result: unknown;
      switch (params.name) {
        case "create_upload": {
          const upload = await service.createUpload(principal, args, !!principal.scopes);
          result = { upload_id: upload.upload_id, expires_at: upload.expires_at, upload_url: `${base}/uploads/${upload.upload_id}`, required_headers: { "X-Upload-Token": upload.upload_token, "Content-Type": "application/octet-stream", ...(upload.upload_auth_token ? { Authorization: `Bearer ${upload.upload_auth_token}` } : {}) } };
          break;
        }
        case "start_conversion": result = await service.startConversion(principal, args.upload_id); break;
        case "get_conversion_status": result = await service.getStatus(principal, args.job_id); break;
        case "get_markdown": result = await service.getMarkdown(principal, args.job_id, { offset: args.offset, max_chars: args.max_chars }); break;
        case "delete_job": result = await service.deleteJob(principal, args.job_id); break;
        case "get_service_health": result = await service.health(principal); break;
        case "lookup_error": {
          result = lookupError(args.code);
          if ((result as { code: string }).code === "UNKNOWN_ERROR_CODE") throw new ServiceError(400, "Unknown error code", "UNKNOWN_ERROR_CODE");
          break;
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(result ?? { deleted: true }) }], isError: false };
    } catch (error) {
      return { content: [{ type: "text", text: JSON.stringify(errorResponse(error)) }], isError: true };
    }
  });
  return server;
}
