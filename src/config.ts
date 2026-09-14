import path from "node:path";
import {
  DEFAULT_FRAME_SCHEDULE_MAX_TARGETS,
  DEFAULT_FRAME_SCHEDULE_PAGE_TARGETS,
} from "./core/frame-schedule.js";
import { chooseDataRoot } from "./distribution/paths.js";

export type UrmaConfig = Readonly<{
  dataDir: string;
  localRoots: readonly string[];
  allowUnc: boolean;
  ffmpeg: string;
  ffprobe: string;
  ytdlp: string;
  runtime?: Readonly<{
    root: string;
    generationDir: string;
    installationId: string;
    receiptPath: string;
    nodeExecutable: string;
    toolHashes: Readonly<{
      ffmpeg: string;
      ffprobe: string;
      ytdlp: string;
    }>;
  }>;
  debug: boolean;
  limits: Readonly<{
    subprocessStdoutBytes: number;
    subprocessStderrBytes: number;
    metadataTimeoutMs: number;
    mediaTimeoutMs: number;
    maxTargetedMediaBytes: number;
    maxNavigationCopyBytes: number;
    maxReusableEvidenceMediaBytes: number;
    maxRemoteAcquisitionWallMs: number;
    maxFrameSchedulePageTargets: number;
    maxFrameScheduleTargets: number;
    resourceBytes: number;
    imageResponseBytes: number;
  }>;
}>;

function booleanEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
function positiveIntegerEnv(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new RangeError(
      `${name} must be a positive integer; received ${JSON.stringify(raw)}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      `${name} must be a positive safe integer; received ${
        JSON.stringify(raw)
      }`,
    );
  }
  return value;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): UrmaConfig {
  const roots = (environment.URMA_LOCAL_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
  const runtimeRoot = environment.URMA_RUNTIME_ROOT_V1;
  const runtimeGeneration = environment.URMA_RUNTIME_GENERATION_V1;
  const runtimeMarkersPresent = runtimeRoot !== undefined || runtimeGeneration !== undefined;
  if (runtimeMarkersPresent && (!runtimeRoot?.trim() || !runtimeGeneration?.trim())) {
    throw new Error("Persistent Urma startup requires both the launcher root and selected generation metadata");
  }
  const runtime = runtimeRoot && runtimeGeneration
    ? (() => {
      if (!path.isAbsolute(runtimeRoot) || runtimeRoot.includes("\0")) {
        throw new Error("URMA_RUNTIME_ROOT_V1 must be an absolute path");
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runtimeGeneration)) {
        throw new Error("URMA_RUNTIME_GENERATION_V1 is not a valid installation id");
      }
      const generationDir = environment.URMA_RUNTIME_GENERATION_DIR_V1
        ? path.resolve(environment.URMA_RUNTIME_GENERATION_DIR_V1)
        : path.join(runtimeRoot, "installs", runtimeGeneration);
      const generationRelative = path.relative(path.resolve(runtimeRoot), generationDir);
      if (
        generationRelative === "" ||
        path.isAbsolute(generationRelative) ||
        generationRelative === ".." ||
        generationRelative.startsWith(`..${path.sep}`)
      ) {
        throw new Error("URMA_RUNTIME_GENERATION_DIR_V1 must remain inside the Urma data directory");
      }
      const ffmpeg = environment.URMA_RUNTIME_FFMPEG_V1;
      const ffprobe = environment.URMA_RUNTIME_FFPROBE_V1;
      const ytdlp = environment.URMA_RUNTIME_YTDLP_V1;
      const ffmpegHash = environment.URMA_RUNTIME_FFMPEG_HASH_V1;
      const ffprobeHash = environment.URMA_RUNTIME_FFPROBE_HASH_V1;
      const ytdlpHash = environment.URMA_RUNTIME_YTDLP_HASH_V1;
      if (
        !ffmpeg || !ffprobe || !ytdlp ||
        !ffmpegHash || !ffprobeHash || !ytdlpHash ||
        !path.isAbsolute(ffmpeg) || !path.isAbsolute(ffprobe) || !path.isAbsolute(ytdlp)
      ) {
        throw new Error("Persistent Urma startup is missing selected generation tool metadata");
      }
      return {
        root: path.resolve(runtimeRoot),
        generationDir: path.resolve(generationDir),
        installationId: runtimeGeneration,
        receiptPath: path.join(generationDir, "receipt.json"),
        nodeExecutable: path.resolve(environment.URMA_RUNTIME_NODE_V1 ?? process.execPath),
        toolHashes: { ffmpeg: ffmpegHash, ffprobe: ffprobeHash, ytdlp: ytdlpHash },
      } as const;
    })()
    : undefined;
  return {
    dataDir: path.resolve(
      runtime === undefined
        ? chooseDataRoot(environment)
        : environment.URMA_RUNTIME_DATA_DIR_V1 ?? runtime.root,
    ),
    localRoots: roots,
    allowUnc: booleanEnv(environment.URMA_ALLOW_UNC),
    ffmpeg: runtime === undefined
      ? environment.URMA_FFMPEG ?? "ffmpeg"
      : path.resolve(environment.URMA_RUNTIME_FFMPEG_V1 as string),
    ffprobe: runtime === undefined
      ? environment.URMA_FFPROBE ?? "ffprobe"
      : path.resolve(environment.URMA_RUNTIME_FFPROBE_V1 as string),
    ytdlp: runtime === undefined
      ? environment.URMA_YTDLP ?? "yt-dlp"
      : path.resolve(environment.URMA_RUNTIME_YTDLP_V1 as string),
    ...(runtime === undefined ? {} : { runtime }),
    debug: booleanEnv(environment.URMA_DEBUG),
    limits: {
      subprocessStdoutBytes: 32 * 1024 * 1024,
      subprocessStderrBytes: 2 * 1024 * 1024,
      metadataTimeoutMs: 60_000,
      mediaTimeoutMs: 180_000,
      maxTargetedMediaBytes: positiveIntegerEnv(
        environment,
        "URMA_MAX_TARGETED_MEDIA_BYTES",
        64 * 1024 * 1024,
      ),
      maxNavigationCopyBytes: positiveIntegerEnv(
        environment,
        "URMA_MAX_NAVIGATION_COPY_BYTES",
        256 * 1024 * 1024,
      ),
      maxReusableEvidenceMediaBytes: positiveIntegerEnv(
        environment,
        "URMA_MAX_REUSABLE_EVIDENCE_MEDIA_BYTES",
        512 * 1024 * 1024,
      ),
      maxRemoteAcquisitionWallMs: positiveIntegerEnv(
        environment,
        "URMA_MAX_REMOTE_ACQUISITION_WALL_MS",
        180_000,
      ),
      maxFrameSchedulePageTargets: (() => {
        const value = positiveIntegerEnv(
          environment,
          "URMA_MAX_FRAME_SCHEDULE_PAGE_TARGETS",
          DEFAULT_FRAME_SCHEDULE_PAGE_TARGETS,
        );
        if (value > DEFAULT_FRAME_SCHEDULE_PAGE_TARGETS) {
          throw new RangeError(
            `URMA_MAX_FRAME_SCHEDULE_PAGE_TARGETS must not exceed ${DEFAULT_FRAME_SCHEDULE_PAGE_TARGETS}; received ${value}`,
          );
        }
        return value;
      })(),
      maxFrameScheduleTargets: positiveIntegerEnv(
        environment,
        "URMA_MAX_FRAME_SCHEDULE_TARGETS",
        DEFAULT_FRAME_SCHEDULE_MAX_TARGETS,
      ),
      resourceBytes: 32 * 1024 * 1024,
      imageResponseBytes: 8 * 1024 * 1024,
    },
  };
}
