import appPackage from "../package.json";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { commands } from "./commands.js";
import { Engine } from "./engine.js";
import { callEngine } from "./server.js";
export function toMcpResult(result: any): any {
  if (result?.frame?.mimeType === "image/jpeg") {
    const { frame, ...preview } = result;
    const formatted = toMcpResult(frame);
    return {
      ...formatted,
      content: [
        { type: "text" as const, text: JSON.stringify(preview) },
        ...formatted.content,
      ],
    };
  }
  if (result?.mimeType === "image/jpeg" && typeof result.data === "string") {
    const { data, ...metadata } = result;
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(metadata) },
        { type: "image" as const, mimeType: result.mimeType, data },
      ],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: { result },
  };
}
export async function startMcp() {
  const server = new McpServer({ name: "shader", version: appPackage.version });
  const registry = commands(new Engine());
  for (const [name, command] of Object.entries(registry))
    server.registerTool(
      name,
      {
        description: command.description,
        inputSchema: command.schema.shape,
        annotations: {
          readOnlyHint: command.readOnly,
          destructiveHint: !command.readOnly,
          idempotentHint: command.readOnly,
          openWorldHint: false,
        },
      },
      async (args: any) => {
        try {
          return toMcpResult(await callEngine(name, args));
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: (e as Error).message }],
          };
        }
      },
    );
  server.registerResource(
    "cameras",
    "shader://cameras",
    {
      description: "Connected cameras and complete capability descriptions",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await callEngine("cameras_list", {})),
        },
      ],
    }),
  );
  await server.connect(new StdioServerTransport());
}
