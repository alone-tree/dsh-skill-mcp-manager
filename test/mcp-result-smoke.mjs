// MCP tool results follow dsh-mcp-client: raw content stays on the value,
// render() is the text projection, and finalizeContent admits images.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { projectContent } from "../lib/mcp-result.js";

const tmp = join(process.cwd(), `.test-mcp-result-${process.pid}`);
const dataDir = join(tmp, "data");
const serverPath = join(tmp, "server.mjs");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

await writeFile(serverPath, `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const PNG = ${JSON.stringify(PNG)};
const server = new Server({ name: "result-probe", version: "1.0.0" }, { capabilities: { tools: {} } });
const inputSchema = { type: "object", additionalProperties: false };
const outputSchema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false };
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "mix", description: "mixed", inputSchema },
  { name: "images", description: "images", inputSchema },
  { name: "badimage", description: "bad image", inputSchema },
  { name: "structured", description: "structured", inputSchema, outputSchema },
  { name: "empty", description: "empty", inputSchema },
  { name: "softfail", description: "error", inputSchema },
]}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "mix") {
    return { content: [
      { type: "text", text: "hello-text" },
      { type: "audio", data: "AQIDBA==", mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "file:///notes/body.txt", mimeType: "text/plain", text: "resource-body-KEEP-ME" } },
      { type: "resource_link", uri: "file:///notes/photo.png", name: "photo.png", mimeType: "image/png" },
    ], structuredContent: { answer: 7 } };
  }
  if (request.params.name === "images") {
    return { content: [
      { type: "text", text: "before" },
      { type: "image", data: PNG, mimeType: "image/png" },
      { type: "text", text: "after" },
    ] };
  }
  if (request.params.name === "badimage") {
    return { content: [
      { type: "image", data: PNG, mimeType: "image/png" },
      { type: "image", data: PNG, mimeType: "image/svg+xml" },
    ] };
  }
  if (request.params.name === "structured") {
    return { content: [], structuredContent: { answer: 42 } };
  }
  if (request.params.name === "softfail") {
    return { content: [{ type: "image", data: PNG, mimeType: "image/png" }], isError: true };
  }
  return { content: [] };
});
await server.connect(new StdioServerTransport());
`, "utf8");

const saved = [];
const registrations = [];
const effects = [];
const ctx = {
  tools: {
    register(definition) {
      const record = { definition, active: true };
      registrations.push(record);
      return () => { record.active = false; };
    },
  },
  skills: { registerProvider() { return () => {}; } },
  on(event, handler) {
    if (event === "agent/pre-step") ctx.preStep = handler;
    return () => {};
  },
  effect(fn) {
    const disposer = fn();
    if (typeof disposer === "function") effects.push(disposer);
    return () => {};
  },
  get(service) {
    if (service === "attachments") {
      return { async saveImages(images) { saved.push(images); return images.map((image, index) => ({ id: `img-${index}`, mediaType: image.mediaType })); } };
    }
    if (service === "llm") return { async resolveModelInfo() { return { inputModalities: ["text", "image"] }; } };
    return undefined;
  },
  logger: { warn() {}, error() {}, info() {} },
  preStep: null,
};

function activeTool(name) {
  return [...registrations].reverse().find((record) => record.active && record.definition.name === name)?.definition;
}

const agent = {
  options: { provider: "test", model: "vision" },
  session: { requestHeader() { return { config: { provider: "test", model: "vision" } }; }, surface: { nodes: [] } },
  ctx: { tools: ctx.tools, effect(fn) { const disposer = fn(); if (typeof disposer === "function") effects.push(disposer); return () => {}; } },
};
const execution = { signal: new AbortController().signal, agent };

function entry(id, tier) {
  return {
    id, name: id, tier, transport: "stdio", command: process.execPath, args: [serverPath],
    env: {}, cwd: process.cwd(), notes: "",
    tools: ["mix", "images", "badimage", "structured", "empty", "softfail"].map((name) => ({ name, description: name })),
    serverDescription: "result probe", metaFetchedAt: "2026-01-01T00:00:00.000Z",
  };
}

await writeFile(join(dataDir, "registry.json"), JSON.stringify({
  version: 1,
  entries: [entry("demo", "on-demand"), entry("eagerdemo", "eager")],
}, null, 2));

function modelContent(tool, args, value, exec) {
  const rendered = tool.output.render(args, value);
  const finalized = tool.finalizeContent?.(exec, { isError: false, value, content: rendered });
  return finalized ?? rendered;
}

const failed = [];
try {
  await apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false, trialTimeoutMs: 8000, toolCallTimeoutMs: 8000 });
  await ctx.preStep({ agent, signal: { throwIfAborted() {} } }, async () => ({ kind: "enter", messages: [] }));
  const mcpLoad = activeTool("mcp_load");
  const mcpCall = activeTool("mcp_call");
  await mcpLoad.execute({ name: "demo" }, execution);

  const mixArgs = { name: "demo", tool: "mix" };
  const mix = await mcpCall.execute(mixArgs, execution);
  if (mix.structuredContent?.answer !== 7) failed.push(`structuredContent dropped from value: ${JSON.stringify(mix.structuredContent)}`);
  if (!JSON.stringify(mix.content).includes("resource-body-KEEP-ME")) failed.push("raw resource text was removed from the return value");
  const mixText = modelContent(mcpCall, mixArgs, mix, execution).map((block) => block.text ?? "").join("\n");
  for (const needle of [
    "hello-text",
    "[audio result unsupported: audio/wav; raw audio data remains available to programmatic callers]",
    "[embedded resource unsupported; raw resource data remains available to programmatic callers]",
    "Resource link: photo.png (file:///notes/photo.png)",
  ]) {
    if (!mixText.includes(needle)) failed.push(`mix projection missing ${needle}\n---\n${mixText}`);
  }
  const missingLink = projectContent([{ type: "resource_link", mimeType: "text/plain" }], "mix").map((block) => block.text).join("\n");
  if (missingLink !== "[resource link unavailable: the MCP block is missing its name or URI]") {
    failed.push(`missing resource link projection: ${missingLink}`);
  }
  if (mixText.includes("resource-body-KEEP-ME") || mixText.includes("\"answer\":7") || mixText.includes("content discarded")) {
    failed.push(`mix projection leaked raw payload:\n${mixText}`);
  }

  const imageArgs = { name: "demo", tool: "images" };
  const imageExec = { signal: new AbortController().signal, agent };
  const images = await mcpCall.execute(imageArgs, imageExec);
  if (images.content?.[1]?.data !== PNG) failed.push("raw image data was not kept on the return value");
  const imageContent = modelContent(mcpCall, imageArgs, images, imageExec);
  if (imageContent.map((block) => block.type).join(",") !== "text,image,text") {
    failed.push(`admitted image was not placed between text: ${JSON.stringify(imageContent)}`);
  }
  if (imageContent[0].text !== "before" || imageContent[2].text !== "after") failed.push(`text order changed: ${JSON.stringify(imageContent)}`);
  if (imageContent[1].attachment?.id !== "img-0" || imageContent[1].attachment?.mediaType !== "image/png") {
    failed.push(`image attachment missing: ${JSON.stringify(imageContent[1])}`);
  }
  if (saved.length !== 1 || saved[0][0].mediaType !== "image/png" || !Buffer.isBuffer(saved[0][0].data)) {
    failed.push("saveImages was not given the decoded PNG");
  }

  const badArgs = { name: "demo", tool: "badimage" };
  const badExec = { signal: new AbortController().signal, agent };
  const bad = await mcpCall.execute(badArgs, badExec);
  const badText = modelContent(mcpCall, badArgs, bad, badExec).map((block) => block.text ?? "").join("\n");
  if (!badText.includes("another image in the same result was invalid")) failed.push(`valid image was admitted beside an invalid one:\n${badText}`);
  if (!badText.includes("the declared media type is not PNG, JPEG, WebP, or GIF")) failed.push(`invalid image reason missing:\n${badText}`);
  if (badText.includes(PNG)) failed.push("invalid batch leaked base64 into the model text");

  const structuredArgs = { name: "demo", tool: "structured" };
  const structured = await mcpCall.execute(structuredArgs, execution);
  if (structured.structuredContent?.answer !== 42) failed.push("structured-only value lost structuredContent");
  const structuredText = modelContent(mcpCall, structuredArgs, structured, execution).map((block) => block.text ?? "").join("\n");
  if (structuredText !== "(structured returned no model-visible content)") failed.push(`empty content projection: ${structuredText}`);

  const eagerStructured = activeTool("mcp__eagerdemo__structured");
  if (eagerStructured?.output?.schema?.required?.join(",") !== "content,structuredContent") {
    failed.push(`eager outputSchema was not required: ${JSON.stringify(eagerStructured?.output?.schema?.required)}`);
  }
  if (mcpCall.output.schema.required.join(",") !== "content") failed.push("mcp_call schema required structuredContent");

  let soft = "";
  try {
    await mcpCall.execute({ name: "demo", tool: "softfail" }, execution);
  } catch (error) {
    soft = String(error?.message ?? error);
  }
  if (!soft.includes("this result was not admitted to durable model context") || soft.includes(PNG)) {
    failed.push(`isError image was not kept out of the model text: ${soft}`);
  }
} finally {
  for (const dispose of effects.reverse()) {
    try { await dispose(); } catch { /* ignore */ }
  }
  await rm(tmp, { recursive: true, force: true });
}

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("MCP RESULT SMOKE FAILED");
  process.exit(1);
}
console.log("MCP RESULT SMOKE PASSED");
