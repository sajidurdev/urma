export const URMA_ERROR_CODES = [
  "INVALID_SOURCE",
  "UNSUPPORTED_SOURCE",
  "SOURCE_UNAVAILABLE",
  "LOCAL_SOURCE_DISABLED",
  "LOCAL_PATH_OUTSIDE_ROOT",
  "LOCAL_FILE_NOT_FOUND",
  "METADATA_UNAVAILABLE",
  "CAPTIONS_UNAVAILABLE",
  "STORYBOARD_UNAVAILABLE",
  "TARGETED_MEDIA_UNAVAILABLE",
  "MEDIA_ACQUISITION_TIMEOUT",
  "MEDIA_BUDGET_EXCEEDED",
  "MEDIA_INVALID",
  "FRAME_EXTRACTION_FAILED",
  "AUDIO_UNAVAILABLE",
  "OUTPUT_LIMIT_EXCEEDED",
  "CACHE_WRITE_FAILED",
  "REQUIRED_BINARY_MISSING",
  "REQUIRED_BINARY_UNSUPPORTED",
  "UNSUPPORTED_PLATFORM",
  "UNSUPPORTED_FILESYSTEM",
  "INSTALLATION_MISSING",
  "INSTALLATION_CORRUPT",
  "INSTALLATION_LOCKED",
  "INSTALLATION_STATE_INCOMPATIBLE",
  "ARTIFACT_DOWNLOAD_FAILED",
  "ARTIFACT_HASH_MISMATCH",
  "ARCHIVE_INVALID",
  "SETUP_FAILED",
  "HOST_REGISTRATION_FAILED",
  "CANCELLED",
  "INTERNAL_ERROR",
] as const;

export type UrmaErrorCode = (typeof URMA_ERROR_CODES)[number];

export class UrmaError extends Error {
  readonly code: UrmaErrorCode;
  readonly retryable: boolean;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: UrmaErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      detail?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "UrmaError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail ?? {};
  }
}

export function normalizeError(error: unknown): UrmaError {
  if (error instanceof UrmaError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new UrmaError("CANCELLED", "Operation was cancelled", {
      cause: error,
    });
  }
  return new UrmaError(
    "INTERNAL_ERROR",
    "Urma could not complete the operation",
    { cause: error },
  );
}
