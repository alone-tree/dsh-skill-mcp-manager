// MCP tool-result projection. Matches dsh-mcp-client: the return value keeps
// the raw MCP result, render() is the text projection, and finalizeContent
// admits images only through the host attachment store. Wording and gates are
// copied from that client; it does not export them.

import { isDeepStrictEqual } from "node:util";
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";

const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// Same membership test as @deepseek-ai/dsh-attachment isImageAdmissionError
// (0.1.5-rc.2). Callers route on `code`, not the prototype, so a second copy
// of the package still classifies the host store's errors.
const IMAGE_ADMISSION_ERROR_CODES = new Set([
  "TOO_MANY_IMAGES",
  "IMAGES_TOO_LARGE",
  "UNSUPPORTED_IMAGE_TYPE",
  "INVALID_IMAGE_BASE64",
  "INVALID_IMAGE",
  "IMAGE_TYPE_MISMATCH",
  "IMAGE_TOO_LARGE",
  "IMAGE_TOO_MANY_PIXELS",
  "IMAGE_DIMENSION_TOO_LARGE",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageAdmissionError(error) {
  return error instanceof Error && typeof error.code === "string" && IMAGE_ADMISSION_ERROR_CODES.has(error.code);
}

function imageDiagnostic(block, reason) {
  return `[image unavailable: ${block.mimeType ?? "unknown media type"}; ${reason}; raw image data remains available to programmatic callers]`;
}

function decodeImage(block) {
  if (block.mimeType === undefined || !IMAGE_MEDIA_TYPES.includes(block.mimeType)) {
    throw new Error("the declared media type is not PNG, JPEG, WebP, or GIF");
  }
  if (block.data === undefined || !CANONICAL_BASE64.test(block.data)) {
    throw new Error("the image data is not canonical base64");
  }
  const data = Buffer.from(block.data, "base64");
  if (data.toString("base64") !== block.data) throw new Error("the image data is not canonical base64");
  return { data, mediaType: block.mimeType };
}

async function resolveImageAdmission(ctx, exec) {
  const attachments = ctx.get("attachments");
  if (attachments === undefined) throw new Error("no attachment store is mounted");
  const routed = exec.agent?.session.requestHeader()?.config;
  const provider = routed?.provider ?? exec.agent?.options.provider;
  const model = routed?.model ?? exec.agent?.options.model;
  const llm = ctx.get("llm");
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error("the current model route could not be resolved");
  }
  let info;
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal);
  } catch {
    throw new Error("the current model route could not be verified");
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes("image")) {
    throw new Error(`model "${model}" does not declare image input`);
  }
  if (exec.signal.aborted) throw new Error("the tool call was canceled before image storage");
  return attachments;
}

export function projectContent(mcpContent, toolName, image = (block) => ({
  type: "text",
  text: imageDiagnostic(block, "this result was not admitted to durable model context"),
})) {
  const projected = [];
  const text = [];
  const flushText = () => {
    if (text.length === 0) return;
    projected.push({ type: "text", text: text.splice(0).join("\n") });
  };
  for (const [index, value] of mcpContent.entries()) {
    if (!isRecord(value)) {
      text.push("[unsupported MCP content block: expected an object]");
      continue;
    }
    switch (value.type) {
      case "text":
        if (value.text !== undefined) text.push(value.text);
        break;
      case "image":
        flushText();
        projected.push(image(value, index));
        break;
      case "resource_link":
        if (value.name === undefined || value.uri === undefined) {
          text.push("[resource link unavailable: the MCP block is missing its name or URI]");
        } else {
          text.push(`Resource link: ${value.name} (${value.uri})`);
        }
        break;
      case "audio":
        text.push(`[audio result unsupported: ${value.mimeType ?? "unknown media type"}; raw audio data remains available to programmatic callers]`);
        break;
      case "resource":
        text.push("[embedded resource unsupported; raw resource data remains available to programmatic callers]");
        break;
      default:
        text.push(`[unsupported MCP content type: ${value.type}]`);
    }
  }
  flushText();
  return projected.length > 0 ? projected : [{
    type: "text",
    text: `(${toolName} returned no model-visible content)`,
  }];
}

export function extractText(mcpContent, toolName) {
  return projectContent(mcpContent, toolName).map((block) => block.text).join("\n");
}

async function prepareImageProjection(ctx, exec, content, toolName) {
  const decoded = [];
  const validationErrors = new Map();
  const imageIndexes = [];
  for (const [index, value] of content.entries()) {
    if (!isRecord(value) || value.type !== "image") continue;
    imageIndexes.push(index);
    try {
      decoded.push(decodeImage(value));
    } catch (error) {
      validationErrors.set(index, error.message);
    }
  }
  if (validationErrors.size > 0) {
    return projectContent(content, toolName, (block, index) => ({
      type: "text",
      text: imageDiagnostic(block, validationErrors.get(index) ?? "another image in the same result was invalid"),
    }));
  }
  let attachments;
  try {
    attachments = await resolveImageAdmission(ctx, exec);
  } catch (error) {
    const reason = error.message;
    return projectContent(content, toolName, (block) => ({
      type: "text",
      text: imageDiagnostic(block, reason),
    }));
  }
  try {
    const refs = await attachments.saveImages(decoded);
    const byIndex = new Map(imageIndexes.map((index, offset) => [index, refs[offset]]));
    return projectContent(content, toolName, (_block, index) => ({
      type: "image",
      attachment: byIndex.get(index),
    }));
  } catch (error) {
    const reason = isImageAdmissionError(error)
      ? `image admission rejected the result: ${error.message}`
      : "durable image storage rejected the result";
    return projectContent(content, toolName, (block) => ({
      type: "text",
      text: imageDiagnostic(block, reason),
    }));
  }
}

function containsImage(content) {
  return content.some((value) => isRecord(value) && value.type === "image");
}

function legacyText(result) {
  const rendered = result && typeof result === "object" && "toolResult" in result
    ? JSON.stringify(result.toolResult)
    : "(no output)";
  return typeof rendered === "string" ? rendered : "(no output)";
}

// Host output contract: raw `content`, plus `structuredContent` when the server
// sent it. isError throws the text projection (plus the plugin's call-context
// suffix). Image batches are remembered on `projections` for finalizeContent.
export async function settleMcpToolResult(ctx, exec, projections, result, toolName, errorSuffix = "") {
  if (!Array.isArray(result?.content)) {
    const text = legacyText(result);
    if (result?.isError === true) throw new Error(text + errorSuffix);
    return {
      content: [{ type: "text", text }],
      ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    };
  }
  const content = result.content;
  const text = extractText(content, toolName);
  if (result.isError === true) throw new Error(text + errorSuffix);
  const value = {
    content,
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
  };
  if (containsImage(content)) {
    projections.set(exec, {
      value,
      fallback: [{ type: "text", text }],
      content: await prepareImageProjection(ctx, exec, content, toolName),
    });
  }
  return value;
}

export function supportedStructuredSchema(candidate) {
  if (candidate === undefined || candidate === null) return undefined;
  try {
    assertSupportedJsonSchema(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

export function createMcpResultOutput(structuredSchema, toolNameFrom) {
  const resolveName = typeof toolNameFrom === "function" ? toolNameFrom : () => toolNameFrom;
  return {
    schema: {
      type: "object",
      properties: {
        content: { type: "array", items: {} },
        structuredContent: structuredSchema ?? {},
      },
      required: structuredSchema === undefined ? ["content"] : ["content", "structuredContent"],
      additionalProperties: false,
    },
    render(args, value) {
      const content = Array.isArray(value?.content) ? value.content : [];
      return [{ type: "text", text: extractText(content, resolveName(args)) }];
    },
  };
}

export function finalizeMcpResultContent(projections, exec, result) {
  const projection = projections.get(exec);
  if (projection === undefined) return undefined;
  projections.delete(exec);
  if (result.isError) return undefined;
  if (!isDeepStrictEqual(result.value, projection.value)) return undefined;
  if (!isDeepStrictEqual(result.content, projection.fallback)) return undefined;
  return projection.content;
}
