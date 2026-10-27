// Credential-free MCP fixture shared by headless tests and manual Desktop QA.
// Start through an MCP client: stdout is reserved for JSON-RPC.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "desktop-origin-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "desktop_ping",
    description: "Credential-free Desktop snapshot test",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name !== "desktop_ping") throw new Error("Unknown fixture tool");
  return { content: [{ type: "text", text: "desktop pong" }] };
});
await server.connect(new StdioServerTransport());
