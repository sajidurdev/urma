import {
  type CallToolResult,
  type ContentBlock,
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import type { UrmaConfig } from "../config.js";
import { artifactIdFromSha256, parseInvestigationRef } from "../core/ids.js";
import { normalizeError, UrmaError } from "../core/errors.js";
import type { EvidenceService } from "../evidence/service.js";
import { BlobStore } from "../store/blob-store.js";
import type { UrmaStore } from "../store/store.js";
import {
  framesInput,
  framesMcpOutput,
  framesOutput,
  inspectInput,
  inspectMcpOutput,
  inspectOutput,
  overviewInput,
  overviewMcpOutput,
  overviewOutput,
  readInput,
  readMcpOutput,
  readOutput,
  searchInput,
  searchMcpOutput,
  searchOutput,
} from "./schemas.js";
import { redactModelText } from "../subprocess/redaction.js";
import { URMA_VERSION } from "../version.js";
import { URMA_SERVER_ICONS } from "./logo.js";
import { projectMcpOutput } from "./projection.js";
import {
  diagnosticLog,
  withExactFrameDiagnostics,
} from "../core/diagnostics.js";

function resourceLink(
  uri: string,
  name: string,
  mimeType: string,
): ContentBlock {
  return { type: "resource_link", uri, name, mimeType };
}
function appendResourceLink(
  content: ContentBlock[],
  seenUris: Set<string>,
  uri: string,
  name: string,
  mimeType: string,
): void {
  if (seenUris.has(uri)) return;
  seenUris.add(uri);
  content.push(resourceLink(uri, name, mimeType));
}
function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value);
  return Buffer.byteLength(text ?? "", "utf8");
}
function investigationRefFromOutput(
  output: Record<string, unknown>,
): string | null {
  if (typeof output.investigationRef === "string") {
    return output.investigationRef;
  }
  const summary = output.stateSummary;
  if (
    typeof summary === "object" &&
    summary !== null &&
    typeof (summary as Record<string, unknown>).investigationRef === "string"
  ) {
    return (summary as Record<string, unknown>).investigationRef as string;
  }
  return null;
}
// Keep visual resources in content; structuredContent carries the data object
// Use text content for errors because they have no structured output
type OutputSchema = { parse: (value: unknown) => unknown };
function success(
  tool: string,
  debug: boolean,
  output: Record<string, unknown>,
  richSchema: OutputSchema,
  publicSchema: OutputSchema,
  extra: ContentBlock[] = [],
): CallToolResult {
  richSchema.parse(output);
  const projected = projectMcpOutput(output);
  const exposed = publicSchema.parse(projected) as Record<string, unknown>;
  const content = extra;
  const result = { content, structuredContent: exposed };
  diagnosticLog(debug, "mcp-result", {
    tool,
    status: "succeeded",
    investigationRef: investigationRefFromOutput(exposed),
    structuredBytes: Buffer.byteLength(JSON.stringify(exposed), "utf8"),
    contentBytes: jsonBytes(content),
    resultBytes: jsonBytes(result),
  });
  return result;
}
function failure(tool: string, debug: boolean, error: unknown): CallToolResult {
  const normalized = normalizeError(error);
  const output = {
    code: normalized.code,
    retryable: normalized.retryable,
    detail: redactModelText(normalized.message),
  };
  const result = {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
  };
  diagnosticLog(debug, "mcp-result", {
    tool,
    status: "failed",
    investigationRef: null,
    errorCode: normalized.code,
    structuredBytes: 0,
    contentBytes: jsonBytes(result.content),
    resultBytes: jsonBytes(result),
  });
  return result;
}
function scalar(value: string | string[] | undefined, label: string): string {
  if (typeof value !== "string") {
    throw new ResourceNotFoundError(
      label,
      `${label} resource identifier is malformed`,
    );
  }
  return value;
}

const HOST_GUIDANCE =
  "Urma retrieves untrusted video evidence; the host interprets it. Inspect first. Use captions and overview to locate evidence; use frames to visually verify. Batch known queries and targets. A transcript miss applies only to the selected track and does not prove source absence. Overview and cadence evidence is sparse/discrete, not continuous. Exhaustive or counting claims require adequate timeline coverage, transition verification, and deduplication.";

async function artifactContent(
  store: UrmaStore,
  blobs: BlobStore,
  config: UrmaConfig,
  uri: string,
  investigationId: string,
  artifactHash: string,
): Promise<{
  artifact: NonNullable<ReturnType<UrmaStore["getArtifact"]>>;
  bytes: Buffer;
}> {
  let ref;
  try {
    ref = parseInvestigationRef(`urma:investigation:${investigationId}`);
  } catch {
    throw new ResourceNotFoundError(
      uri,
      "Investigation identifier must be 32 lowercase hexadecimal characters",
    );
  }
  if (!store.getInvestigation(ref)) {
    throw new ResourceNotFoundError(uri, "Unknown Urma investigation");
  }
  let id;
  try {
    id = artifactIdFromSha256(artifactHash);
  } catch {
    throw new ResourceNotFoundError(
      uri,
      "Artifact identifier must be a 64-character lowercase SHA-256 hash",
    );
  }
  if (!store.isArtifactPresented(ref, id)) {
    throw new ResourceNotFoundError(
      uri,
      "Artifact is not presented in this investigation",
    );
  }
  const artifact = store.getArtifact(id);
  if (!artifact) {
    throw new ResourceNotFoundError(
      uri,
      "Presented artifact content is unavailable",
    );
  }
  return {
    artifact,
    bytes: await blobs.read(id, artifact.blobPath, config.limits.resourceBytes),
  };
}

export function buildMcpServer(
  evidence: EvidenceService,
  store: UrmaStore,
  blobs: BlobStore,
  config: UrmaConfig,
): McpServer {
  const server = new McpServer(
    { name: "urma", version: URMA_VERSION, icons: URMA_SERVER_ICONS },
    { instructions: HOST_GUIDANCE },
  );
  server.registerTool(
    "inspect_video",
    {
      title: "Inspect video",
      description:
        "Inspect a finite video and start an investigation pinned to that snapshot. Use first for a new source; refresh only for a new snapshot.",
      inputSchema: inspectInput,
      outputSchema: inspectMcpOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, ctx) => {
      try {
        return success(
          "inspect_video",
          config.debug,
          await evidence.inspectVideo(args, ctx.mcpReq.signal),
          inspectOutput,
          inspectMcpOutput,
        );
      } catch (error) {
        return failure("inspect_video", config.debug, error);
      }
    },
  );
  server.registerTool(
    "search_transcript",
    {
      title: "Search caption track",
      description:
        "Search source-provided captions for temporal clues. Batch related queries; hits are not visual proof and misses apply only to the selected track.",
      inputSchema: searchInput,
      outputSchema: searchMcpOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, ctx) => {
      try {
        return success(
          "search_transcript",
          config.debug,
          await evidence.searchTranscript(
            {
              investigationRef: parseInvestigationRef(args.investigationRef),
              ...(args.query === undefined ? {} : { query: args.query }),
              ...(args.queries === undefined ? {} : { queries: args.queries }),
              ...(args.trackRef ? { trackRef: args.trackRef } : {}),
              ...(args.mode ? { mode: args.mode } : {}),
              ...(args.limit ? { limit: args.limit } : {}),
            },
            ctx.mcpReq.signal,
          ),
          searchOutput,
          searchMcpOutput,
        );
      } catch (error) {
        return failure("search_transcript", config.debug, error);
      }
    },
  );
  server.registerTool(
    "read_transcript",
    {
      title: "Read caption track",
      description:
        "Read timestamped caption segments from a bounded interval.",
      inputSchema: readInput,
      outputSchema: readMcpOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, ctx) => {
      try {
        return success(
          "read_transcript",
          config.debug,
          await evidence.readTranscript(
            {
              investigationRef: parseInvestigationRef(args.investigationRef),
              startMs: args.startMs,
              endMs: args.endMs,
              ...(args.trackRef ? { trackRef: args.trackRef } : {}),
              ...(args.cursor ? { cursor: args.cursor } : {}),
            },
            ctx.mcpReq.signal,
          ),
          readOutput,
          readMcpOutput,
        );
      } catch (error) {
        return failure("read_transcript", config.debug, error);
      }
    },
  );
  server.registerTool(
    "get_overview",
    {
      title: "Get 12-cell locator overview",
      description:
        "Get a sparse 12-cell visual locator for a video or interval. Use to find moments; samples are not continuous coverage.",
      inputSchema: overviewInput,
      outputSchema: overviewMcpOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, ctx) => {
      try {
        const output = await evidence.getOverview(
          {
            investigationRef: parseInvestigationRef(args.investigationRef),
            ...(args.startMs === undefined ? {} : { startMs: args.startMs }),
            ...(args.endMs === undefined ? {} : { endMs: args.endMs }),
          },
          ctx.mcpReq.signal,
        );
        const stored = store.getArtifact(output.artifact.artifactId);
        if (!stored) {
          throw new Error(
            "Overview artifact disappeared before MCP presentation",
          );
        }
        const bytes = await blobs.read(
          stored.artifactId,
          stored.blobPath,
          config.limits.resourceBytes,
        );
        const content: ContentBlock[] = [
          resourceLink(
            output.artifact.resource,
            "12-cell locator overview",
            stored.mimeType,
          ),
        ];
        if (bytes.length <= config.limits.imageResponseBytes) {
          content.unshift({
            type: "image",
            data: bytes.toString("base64"),
            mimeType: stored.mimeType,
          });
        }
        return success(
          "get_overview",
          config.debug,
          output,
          overviewOutput,
          overviewMcpOutput,
          content,
        );
      } catch (error) {
        return failure("get_overview", config.debug, error);
      }
    },
  );
  server.registerTool(
    "get_frames",
    {
      title: "Get exact or ordered sparse frames",
      description:
        "Get deterministic frame evidence at explicit points, a burst, or fixed cadence. Batch known targets; cadence is discrete, not continuous.",
      inputSchema: framesInput,
      outputSchema: framesMcpOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      await withExactFrameDiagnostics(
        config.debug,
        {
          requestKind: args.request?.kind ?? "cadence",
          presentation: args.presentation ?? "individual",
        },
        async (trace) => {
          try {
            const output = await evidence.getFrames(
              {
                investigationRef: parseInvestigationRef(args.investigationRef),
                ...(args.request === undefined
                  ? {}
                  : { request: args.request }),
                ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
                ...(args.pageSize === undefined
                  ? {}
                  : { pageSize: args.pageSize }),
                ...(args.maxTargets === undefined
                  ? {}
                  : { maxTargets: args.maxTargets }),
                ...(args.presentation
                  ? { presentation: args.presentation }
                  : {}),
              },
              ctx.mcpReq.signal,
            );
            const mcpResultStarted = performance.now();
            try {
              if ("schedule" in output) {
                const successful = output.slots.filter(
                  (slot) => slot.status === "success",
                );
                const uniqueArtifacts = new Map<
                  string,
                  (typeof successful)[number]
                >();
                for (const slot of successful) {
                  if (!uniqueArtifacts.has(slot.artifactId)) {
                    uniqueArtifacts.set(slot.artifactId, slot);
                  }
                }
                const uniqueBytes = [...uniqueArtifacts.values()].reduce(
                  (sum, slot) => sum + slot.byteSize,
                  0,
                );
                const inlineIndividual = output.presentation === "individual" ||
                  !output.panel;
                const inline = inlineIndividual &&
                  uniqueBytes <= config.limits.imageResponseBytes;
                const content: ContentBlock[] = [];
                const seenResourceUris = new Set<string>();
                if (output.presentation === "panel" && output.panel) {
                  const panelArtifact = store.getArtifact(
                    output.panel.artifactId,
                  );
                  if (!panelArtifact) {
                    throw new UrmaError(
                      "INTERNAL_ERROR",
                      "Derived cadence frame panel disappeared before MCP presentation",
                    );
                  }
                  const panelBytes = await blobs.read(
                    panelArtifact.artifactId,
                    panelArtifact.blobPath,
                    config.limits.resourceBytes,
                  );
                  if (panelBytes.length > config.limits.imageResponseBytes) {
                    throw new UrmaError(
                      "OUTPUT_LIMIT_EXCEEDED",
                      `Derived cadence frame panel exceeds the ${config.limits.imageResponseBytes}-byte inline image ceiling`,
                    );
                  }
                  appendResourceLink(
                    content,
                    seenResourceUris,
                    output.panel.resource,
                    "Derived cadence exact-frame panel",
                    panelArtifact.mimeType,
                  );
                  content.push({
                    type: "image",
                    data: panelBytes.toString("base64"),
                    mimeType: panelArtifact.mimeType,
                  });
                }
                const emittedImages = new Set<string>();
                for (const slot of successful) {
                  appendResourceLink(
                    content,
                    seenResourceUris,
                    slot.resource,
                    `Scheduled exact frame ${slot.index} at ${slot.requestedAtMs} ms`,
                    slot.mimeType,
                  );
                  if (!inline || emittedImages.has(slot.artifactId)) continue;
                  const artifact = store.getArtifact(slot.artifactId);
                  if (!artifact) continue;
                  const bytes = await blobs.read(
                    artifact.artifactId,
                    artifact.blobPath,
                    config.limits.resourceBytes,
                  );
                  content.push({
                    type: "image",
                    data: bytes.toString("base64"),
                    mimeType: artifact.mimeType,
                  });
                  emittedImages.add(slot.artifactId);
                }
                diagnosticLog(config.debug, "get-frames-presentation", {
                  presentation: output.presentation,
                  requestedTimestamps: output.slots
                    .map((slot) => slot.requestedAtMs)
                    .join(","),
                  exactFramesReturned: successful.length,
                  inlineImageCount:
                    (output.presentation === "panel" && output.panel ? 1 : 0) +
                    emittedImages.size,
                  inlineImageBytes: inline
                    ? (output.presentation === "panel" && output.panel
                      ? output.panel.byteSize
                      : uniqueBytes)
                    : 0,
                  canonicalArtifactCount: successful.length,
                  canvasWidth: output.presentation === "panel" && output.panel
                    ? output.panel.width
                    : null,
                  canvasHeight: output.presentation === "panel" && output.panel
                    ? output.panel.height
                    : null,
                  cellCount: output.presentation === "panel" && output.panel
                    ? output.panel.cellCount
                    : 0,
                });
                return success(
                  "get_frames",
                  config.debug,
                  output,
                  framesOutput,
                  framesMcpOutput,
                  content,
                );
              }
              if ("presentation" in output && output.presentation === "panel") {
                const artifact = store.getArtifact(output.panel.artifactId);
                if (!artifact) {
                  throw new UrmaError(
                    "INTERNAL_ERROR",
                    "Derived frame panel disappeared before MCP presentation",
                  );
                }
                const bytes = await blobs.read(
                  artifact.artifactId,
                  artifact.blobPath,
                  config.limits.resourceBytes,
                );
                if (bytes.length > config.limits.imageResponseBytes) {
                  throw new UrmaError(
                    "OUTPUT_LIMIT_EXCEEDED",
                    `Derived frame panel exceeds the ${config.limits.imageResponseBytes}-byte inline image ceiling; split the timestamp request into smaller panel calls`,
                  );
                }
                const content: ContentBlock[] = [];
                const seenResourceUris = new Set<string>();
                appendResourceLink(
                  content,
                  seenResourceUris,
                  output.panel.resource,
                  "Derived exact-frame panel",
                  artifact.mimeType,
                );
                for (const cell of output.cells) {
                  appendResourceLink(
                    content,
                    seenResourceUris,
                    cell.resource,
                    `Exact frame at ${cell.timestampMs} ms`,
                    cell.mimeType,
                  );
                }
                content.unshift({
                  type: "image",
                  data: bytes.toString("base64"),
                  mimeType: artifact.mimeType,
                });
                diagnosticLog(config.debug, "get-frames-presentation", {
                  presentation: "panel",
                  requestedTimestamps: output.cells
                    .map((cell) => cell.timestampMs)
                    .join(","),
                  exactFramesReturned: output.cells.length,
                  inlineImageCount: 1,
                  inlineImageBytes: bytes.length,
                  canonicalArtifactCount: output.cells.length,
                  canvasWidth: output.panel.width,
                  canvasHeight: output.panel.height,
                  cellCount: output.panel.cellCount,
                });
                return success(
                  "get_frames",
                  config.debug,
                  output,
                  framesOutput,
                  framesMcpOutput,
                  content,
                );
              }
              const uniqueArtifacts = new Map<
                string,
                (typeof output.frames)[number]
              >();
              for (const frame of output.frames) {
                if (!uniqueArtifacts.has(frame.artifactId)) {
                  uniqueArtifacts.set(frame.artifactId, frame);
                }
              }
              const uniqueBytes = [...uniqueArtifacts.values()].reduce(
                (sum, frame) => sum + frame.byteSize,
                0,
              );
              const inline = uniqueBytes <= config.limits.imageResponseBytes;
              const content: ContentBlock[] = [];
              const seenResourceUris = new Set<string>();
              const emittedImages = new Set<string>();
              for (const frame of output.frames) {
                appendResourceLink(
                  content,
                  seenResourceUris,
                  frame.resource,
                  `Exact frame at ${frame.atMs} ms`,
                  frame.mimeType,
                );
                if (inline && !emittedImages.has(frame.artifactId)) {
                  const artifact = store.getArtifact(frame.artifactId);
                  if (artifact) {
                    const bytes = await blobs.read(
                      artifact.artifactId,
                      artifact.blobPath,
                      config.limits.resourceBytes,
                    );
                    content.push({
                      type: "image",
                      data: bytes.toString("base64"),
                      mimeType: artifact.mimeType,
                    });
                    emittedImages.add(frame.artifactId);
                  }
                }
              }
              diagnosticLog(config.debug, "get-frames-presentation", {
                presentation: "individual",
                requestedTimestamps: output.frames
                  .map((frame) => frame.atMs)
                  .join(","),
                exactFramesReturned: output.frames.length,
                inlineImageCount: emittedImages.size,
                inlineImageBytes: inline ? uniqueBytes : 0,
                canonicalArtifactCount: output.frames.length,
                canvasWidth: null,
                canvasHeight: null,
                cellCount: 0,
              });
              return success(
                "get_frames",
                config.debug,
                output,
                framesOutput,
                framesMcpOutput,
                content,
              );
            } finally {
              trace?.addStage(
                "mcpResultConstructionMs",
                performance.now() - mcpResultStarted,
              );
            }
          } catch (error) {
            trace?.markFailure(error);
            const failureStarted = performance.now();
            try {
              return failure("get_frames", config.debug, error);
            } finally {
              trace?.addStage(
                "mcpResultConstructionMs",
                performance.now() - failureStarted,
              );
            }
          }
        },
      ),
  );
  server.registerResource(
    "investigation-artifact",
    new ResourceTemplate(
      "urma://investigation/{investigationId}/artifact/{artifactHash}",
      { list: undefined },
    ),
    {
      title: "Investigation-presented Urma artifact",
      description:
        "Reopen immutable evidence already presented in this investigation. Reopening does not add temporal coverage.",
      mimeType: "application/octet-stream",
    },
    async (uri, variables) => {
      const investigationId = scalar(variables.investigationId, uri.href);
      const hash = scalar(variables.artifactHash, uri.href);
      const { artifact, bytes } = await artifactContent(
        store,
        blobs,
        config,
        uri.href,
        investigationId,
        hash,
      );
      const textual = artifact.mimeType.startsWith("text/") ||
        artifact.mimeType === "application/json" ||
        artifact.mimeType === "application/x-subrip";
      return {
        contents: [
          textual
            ? {
              uri: uri.href,
              mimeType: artifact.mimeType,
              text: bytes.toString("utf8"),
            }
            : {
              uri: uri.href,
              mimeType: artifact.mimeType,
              blob: bytes.toString("base64"),
            },
        ],
      };
    },
  );
  server.registerResource(
    "investigation-state",
    new ResourceTemplate("urma://investigation/{investigationId}/state", {
      list: undefined,
    }),
    {
      title: "Urma investigation state",
      description:
        "Complete persisted acquisition, cache, and presentation state for one evidence investigation.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = scalar(variables.investigationId, uri.href);
      let ref;
      try {
        ref = parseInvestigationRef(`urma:investigation:${id}`);
      } catch {
        throw new ResourceNotFoundError(
          uri.href,
          "Investigation identifier must be 32 lowercase hexadecimal characters",
        );
      }
      if (!store.getInvestigation(ref)) {
        throw new ResourceNotFoundError(
          uri.href,
          `Unknown Urma investigation ${id}`,
        );
      }
      const text = JSON.stringify(evidence.state(ref), null, 2);
      if (Buffer.byteLength(text) > config.limits.resourceBytes) {
        throw new ResourceNotFoundError(
          uri.href,
          `Investigation state exceeds the configured ${config.limits.resourceBytes}-byte resource ceiling; use compact tool state summaries`,
        );
      }
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text }],
      };
    },
  );
  return server;
}
