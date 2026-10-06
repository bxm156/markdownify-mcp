import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { JobService, ServiceError } from "./jobs.js";
import type { Principal } from "./identity.js";

const id = z.string().uuid();
const definitions = {
  create_upload: { description: "Reserve a temporary upload owned by your authenticated agent. The runtime must PUT binary bytes to upload_url with required_headers plus its own Authorization: Bearer agent credential. Files do not pass through MCP.", schema: z.strictObject({ filename: z.string().min(1).max(255), size_bytes: z.number().int().positive() }) },
  start_conversion: { description: "Queue conversion of a completed upload and return immediately.", schema: z.strictObject({ upload_id: id }) },
  get_conversion_status: { description: "Poll a conversion job for its current status.", schema: z.strictObject({ job_id: id }) },
  get_markdown: { description: "Retrieve completed Markdown in bounded pages. Follow next_offset until null.", schema: z.strictObject({ job_id: id, offset: z.number().int().nonnegative().optional(), max_chars: z.number().int().min(1).max(100000).optional() }) },
  delete_job: { description: "Delete a temporary upload or conversion job and its stored files.", schema: z.strictObject({ job_id: id }) },
};

export function createRemoteServer(service: JobService, publicBaseUrl: string, principal: Principal): Server {
  const base = publicBaseUrl.replace(/\/$/, "");
  const server = new Server({ name: "markdownify-remote", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.entries(definitions).map(([name, definition]) => ({ name, description: definition.description, inputSchema: z.toJSONSchema(definition.schema) as any })) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const definition = definitions[params.name as keyof typeof definitions];
      if (!definition) return { isError: true, content: [{ type: "text", text: "Unknown tool" }] };
      const parsed = definition.schema.safeParse(params.arguments ?? {});
      if (!parsed.success) return { isError: true, content: [{ type: "text", text: "Invalid tool arguments" }] };
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
      }
      return { content: [{ type: "text", text: JSON.stringify(result ?? { deleted: true }) }], isError: false };
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof ServiceError ? error.message : "Operation failed" }], isError: true };
    }
  });
  return server;
}
