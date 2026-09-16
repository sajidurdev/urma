import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { UrmaConfig } from "../config.js";
import { diagnosticLog } from "../core/diagnostics.js";
import { deterministicRequestKey } from "../core/request-key.js";
import type { ResolvedSource } from "../sources/types.js";
import { Ffmpeg } from "../subprocess/ffmpeg.js";
import { collectBinaryVersions } from "../subprocess/versions.js";
import { BlobStore } from "../store/blob-store.js";
import type { StoredArtifact, UrmaStore } from "../store/store.js";
import { URMA_VERSION } from "../version.js";
import {
  createPanel,
  framePanelDimensions,
  type PanelDimensions,
} from "./panel.js";

type ExactFrame = Readonly<{ atMs: number; artifact: StoredArtifact }>;
type FramePanelResult = Readonly<{
  artifact: StoredArtifact;
  dimensions: PanelDimensions;
  cacheHit: boolean;
}>;

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function sameNumbers(value: unknown, expected: readonly number[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

export class FramePanelAcquirer {
  constructor(
    readonly config: UrmaConfig,
    readonly store: UrmaStore,
    readonly blobs: BlobStore,
  ) {}

  async get(
    source: ResolvedSource,
    frames: readonly ExactFrame[],
    signal?: AbortSignal,
  ): Promise<FramePanelResult> {
    const timesMs = frames.map((frame) => frame.atMs);
    const artifactIds = frames.map((frame) => frame.artifact.artifactId);
    const dimensions = framePanelDimensions(frames.length);
    const requestKey = deterministicRequestKey(
      source.revision,
      "frame-panel",
      { timesMs, artifactIds },
      "frame-panel",
    );
    const cached = this.store.getArtifactByRequest(requestKey);
    if (
      cached?.kind === "frame_panel" &&
      cached.role === "locator" &&
      cached.mimeType === "image/jpeg" &&
      cached.params.canonical === false &&
      sameNumbers(cached.params.pointsMs, timesMs) &&
      sameStrings(cached.params.artifactIds, artifactIds)
    ) {
      try {
        await this.blobs.verify(cached.artifactId, cached.blobPath);
        diagnosticLog(this.config.debug, "frame-panel", {
          status: "cache-hit",
          cellCount: frames.length,
          canvasWidth: dimensions.width,
          canvasHeight: dimensions.height,
          imageBytes: cached.byteSize,
        });
        return { artifact: cached, dimensions, cacheHit: true };
      } catch {
      }
    }

    const working = await mkdtemp(
      path.join(this.config.dataDir, "tmp-frame-panel-"),
    );
    try {
      const paths: string[] = [];
      for (const frame of frames) {
        paths.push(
          await this.blobs.verify(
            frame.artifact.artifactId,
            frame.artifact.blobPath,
          ),
        );
      }
      const output = path.join(working, "panel.jpg");
      await createPanel(this.config, paths, timesMs, output, signal, {
        presentation: "exact-frames",
      });
      const blob = await this.blobs.putFile(
        output,
        (file) => new Ffmpeg(this.config).validateJpeg(file),
      );
      const versions = await collectBinaryVersions(
        this.config,
        ["ffmpeg"],
        signal,
      );
      const artifact: StoredArtifact = {
        artifactId: blob.artifactId,
        sourceRef: source.sourceRef,
        sourceRevision: source.revision,
        kind: "frame_panel",
        role: "locator",
        mimeType: "image/jpeg",
        sha256: blob.sha256,
        byteSize: blob.byteSize,
        blobPath: blob.relativePath,
        startMs: Math.min(...timesMs),
        endMs: Math.max(...timesMs),
        params: {
          presentation: "panel",
          canonical: false,
          pointsMs: timesMs,
          artifactIds,
          count: frames.length,
        },
        producer: {
          version: "frame-panel",
          urmaVersion: URMA_VERSION,
          ...versions,
          ...dimensions,
          deterministic: true,
        },
        createdAt: new Date().toISOString(),
      };
      this.store.putArtifact(
        artifact,
        { requestKey, operation: "frame-panel" },
        artifactIds,
      );
      diagnosticLog(this.config.debug, "frame-panel", {
        status: "generated",
        cellCount: frames.length,
        canvasWidth: dimensions.width,
        canvasHeight: dimensions.height,
        imageBytes: artifact.byteSize,
      });
      return { artifact, dimensions, cacheHit: false };
    } finally {
      await rm(working, { recursive: true, force: true });
    }
  }
}
