import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { JobService, ServiceError } from "./jobs.js";
import type { Principal } from "./identity.js";
import { errorResponse, lookupError } from "./errors.js";

const id = z.string().uuid();
const definitions = {
  create_upload: { description: "Use first when converting a new accessible file, or replacing an expired/failed job. Reserve private storage using basename and actual byte count. Runtime must PUT bytes to upload_url with required_headers plus owner bearer Authorization; files do not pass through MCP. On quota/size failure, follow error_info.next_steps or lookup_error; do not blindly retry or create duplicate reservations.", schema: z.strictObject({ filename: z.string().min(1).max(255), size_bytes: z.number().int().positive() }) },
  start_conversion: { description: "Use only after the binary PUT succeeds. Queue your uploaded file and return promptly. Repeated calls are idempotent; failed jobs are not restarted. Poll get_conversion_status next. Concurrency limits queue work; do not create duplicate jobs.", schema: z.strictObject({ upload_id: id }) },
  get_conversion_status: { description: "Use to resume a saved job or poll after start_conversion with backoff and a finite deadline. For completed, call get_markdown. For failed, stop polling and follow error_info.next_steps or lookup_error(error_info.code). Only your own jobs are accessible.", schema: z.strictObject({ job_id: id }) },
  get_markdown: { description: "Use only when get_conversion_status says completed. Retrieve bounded pages; append markdown and follow next_offset until null. Offsets count Unicode code points, not bytes/string length. Save the result before authorized cleanup; expired results need a new upload.", schema: z.strictObject({ job_id: id, offset: z.number().int().nonnegative().optional(), max_chars: z.number().int().min(1).max(100000).optional() }) },
  delete_job: { description: "Use for authorized cleanup of your own unneeded job after saving results, or to free quota. Permanently removes input/result and cancels active work. Retain jobs needed for later retrieval; never delete another agent's files. No job-listing tool exists: retain IDs you create.", schema: z.strictObject({ job_id: id }) },
  lookup_error: { description: "Use when a tool, upload response or failed status returns error_info.code and you need recovery guidance. Returns the code's meaning, retryable flag and next_steps. This static lookup does not inspect jobs or reveal credentials/other-agent usage; instance-specific limits are in the original error_info.details. retryable never means unlimited retries.", schema: z.strictObject({ code: z.string().min(1).max(64) }) },
};

export function createRemoteServer(service: JobService, publicBaseUrl: string, principal: Principal): Server {
  const base = publicBaseUrl.replace(/\/$/, "");
  const server = new Server({ name: "markdownify-remote", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.entries(definitions).map(([name, definition]) => ({ name, description: definition.description, inputSchema: z.toJSONSchema(definition.schema) as any })) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const definition = Object.hasOwn(definitions, params.name) ? definitions[params.name as keyof typeof definitions] : undefined;
      if (!definition) throw new ServiceError(400, "Unknown tool", "UNKNOWN_TOOL");
      const parsed = definition.schema.safeParse(params.arguments ?? {});
      if (!parsed.success) throw new ServiceError(400, "Invalid tool arguments", "INVALID_ARGUMENTS");
      const args = parsed.data as any;
      let result: unknown;
      switch (params.name) {
        case "create_upload": {
          const upload = await service.createUpload(principal, args);
          result = { upload_id: upload.upload_id, expires_at: upload.expires_at, upload_url: `${base}/uploads/${upload.upload_id}`, required_headers: { "X-Upload-Token": upload.upload_token, "Content-Type": "application/octet-stream" } };
          break;
        }
        case "start_conversion": result = await service.startConversion(principal, args.upload_id); break;
        case "get_conversion_status": result = await service.getStatus(principal, args.job_id); break;
        case "get_markdown": result = await service.getMarkdown(principal, args.job_id, { offset: args.offset, max_chars: args.max_chars }); break;
        case "delete_job": result = await service.deleteJob(principal, args.job_id); break;
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
