import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("context measurement reports MCP components and result compatibility without fixed byte counts", () => {
  const environment = { ...process.env };
  delete environment.URMA_DEBUG;
  delete environment.URMA_DEBUG_FILE;
  const script = path.resolve(
    process.cwd(),
    "scripts/measure-context-efficiency.mjs",
  );
  const run = spawnSync(process.execPath, [script, "--json"], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  assert.equal(run.stderr, "");
  const report = JSON.parse(run.stdout) as {
    discovery: {
      initialize: { chars: number; utf8Bytes: number };
      iconPresent: boolean;
      serverInstructions: { chars: number; utf8Bytes: number };
      toolDescriptions: { chars: number; utf8Bytes: number };
      inputSchemas: { chars: number; utf8Bytes: number };
      outputSchemas: { chars: number; utf8Bytes: number };
      resourceTemplates: { chars: number; utf8Bytes: number };
      toolNames: string[];
      tools: Array<
        Record<string, { chars: number; utf8Bytes: number } | string>
      >;
      toolNamesAndMiscMetadata: { chars: number; utf8Bytes: number };
      toolsCombined: { chars: number; utf8Bytes: number };
      toolsListResponse: { chars: number; utf8Bytes: number };
      grandTotal: { chars: number; utf8Bytes: number };
    };
    baselineComparison: {
      initialize: { delta: { chars: number; utf8Bytes: number } };
      toolsList: { delta: { chars: number; utf8Bytes: number } };
      serverInstructions: { delta: { chars: number; utf8Bytes: number } };
      toolDescriptions: { delta: { chars: number; utf8Bytes: number } };
      inputSchemas: { delta: { chars: number; utf8Bytes: number } };
      outputSchemas: { delta: { chars: number; utf8Bytes: number } };
    };
    compatibilityExperiment: {
      shapeA: {
        accepted: boolean;
        hasStructuredContent: boolean;
        textBlock: boolean;
      };
      shapeB: {
        accepted: boolean;
        hasStructuredContent: boolean;
        textBlock: boolean;
      };
    };
    resultDuplication: Array<{
      tool: string;
      structuredPayloadBytes: number;
      textDuplicateBytes: number;
      combinedResultBytes: number;
      textualCombinedResultBytes: number;
    }>;
    representativeResults: Record<
      string,
      {
        combinedResultBytes: number;
        structuredPayloadBytes: number;
        inlineImageCount: number;
        resourceLinkCount: number;
        textDuplicateBytes: number;
      }
    >;
    framePresentationComparison: {
      timestampCount: number;
      individual: {
        inlineImageCount: number;
        inlineImageBytes: number;
        totalInlinePixels: number;
        mcpResultBytes: number;
      };
      panel: {
        inlineImageCount: number;
        inlineImageBytes: number;
        totalInlinePixels: number;
        mcpResultBytes: number;
        canvas: { width: number; height: number };
      };
      measurementSemantics: string;
    };
  };

  assert.deepEqual(report.discovery.toolNames, [
    "inspect_video",
    "search_transcript",
    "read_transcript",
    "get_overview",
    "get_frames",
  ]);
  assert.equal(report.discovery.tools.length, 5);
  assert.equal(report.discovery.iconPresent, false);
  assert(report.discovery.initialize.utf8Bytes > 0);
  assert(report.discovery.toolDescriptions.utf8Bytes > 0);
  assert(report.discovery.inputSchemas.utf8Bytes > 0);
  assert(report.discovery.outputSchemas.utf8Bytes > 0);
  assert(report.discovery.resourceTemplates.utf8Bytes > 0);
  for (const tool of report.discovery.tools) {
    for (
      const field of [
        "description",
        "inputSchema",
        "outputSchema",
        "total",
      ] as const
    ) {
      const value = tool[field];
      assert.equal(typeof value, "object");
      assert.equal(typeof (value as { chars: number }).chars, "number");
      assert.equal(typeof (value as { utf8Bytes: number }).utf8Bytes, "number");
    }
  }
  for (
    const value of [
      report.discovery.serverInstructions,
      report.discovery.toolNamesAndMiscMetadata,
      report.discovery.toolsCombined,
      report.discovery.toolsListResponse,
      report.discovery.grandTotal,
    ]
  ) {
    assert.equal(typeof value.chars, "number");
    assert.equal(typeof value.utf8Bytes, "number");
  }

  assert.equal(report.compatibilityExperiment.shapeA.accepted, true);
  assert.equal(
    report.compatibilityExperiment.shapeA.hasStructuredContent,
    true,
  );
  assert.equal(report.compatibilityExperiment.shapeA.textBlock, true);
  assert.equal(report.compatibilityExperiment.shapeB.accepted, true);
  assert.equal(
    report.compatibilityExperiment.shapeB.hasStructuredContent,
    true,
  );
  assert.equal(report.compatibilityExperiment.shapeB.textBlock, false);
  assert.deepEqual(
    report.resultDuplication.map((item) => item.tool),
    [
      "inspect_video",
      "search_transcript single",
      "search_transcript batch",
      "read_transcript",
      "get_overview",
      "get_frames",
    ],
  );
  assert(
    report.resultDuplication.every(
      (item) =>
        item.structuredPayloadBytes > 0 &&
        item.combinedResultBytes >= item.textualCombinedResultBytes &&
        item.textDuplicateBytes === 0,
    ),
  );
  assert.deepEqual(
    Object.keys(report.representativeResults).sort(),
    [
      "get_frames_12_frames",
      "get_frames_1_frame",
      "get_frames_6_frames",
      "get_frames_cadence_page",
      "get_frames_panel_page",
      "get_frames_repeated_artifact",
      "get_overview",
      "inspect_video",
      "read_transcript",
      "search_transcript_batch",
      "search_transcript_single",
    ],
  );
  assert.equal(
    report.representativeResults.get_frames_repeated_artifact!
      .inlineImageCount,
    1,
  );
  assert(
    Object.values(report.representativeResults).every(
      (item) => item.structuredPayloadBytes > 0 && item.textDuplicateBytes === 0,
    ),
  );
  assert.equal(report.framePresentationComparison.timestampCount, 12);
  assert.equal(
    report.framePresentationComparison.individual.inlineImageCount,
    12,
  );
  assert.equal(report.framePresentationComparison.panel.inlineImageCount, 1);
  assert.deepEqual(report.framePresentationComparison.panel.canvas, {
    width: 1_280,
    height: 636,
  });
  assert(
    report.framePresentationComparison.panel.inlineImageBytes <
      report.framePresentationComparison.individual.inlineImageBytes,
  );
  assert(
    report.framePresentationComparison.panel.totalInlinePixels <
      report.framePresentationComparison.individual.totalInlinePixels,
  );
  assert(
    report.framePresentationComparison.panel.mcpResultBytes <
      report.framePresentationComparison.individual.mcpResultBytes,
  );
  assert.match(
    report.framePresentationComparison.measurementSemantics,
    /Codex host probe.*independently model-visible/iu,
  );
});
