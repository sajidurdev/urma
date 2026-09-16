import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import type { ArtifactId, InvestigationRef, SourceRef } from "../core/ids.js";
import {
  artifactHashFromId,
  parseArtifactId,
  sha256 as hashText,
  stableJson,
} from "../core/ids.js";
import { UrmaError } from "../core/errors.js";
import { CREATE_FTS, CURRENT_SCHEMA, SCHEMA_VERSION } from "./schema.js";
import type {
  StoredAcquisition,
  StoredArtifact,
  StoredInvestigation,
  StoredPresentation,
  StoredSegment,
  StoredSource,
  StoredSourceLocator,
  StoredSourceSnapshot,
  StoredTrack,
  UrmaStore,
} from "./store.js";

type DbRow = Record<string, unknown>;

const REQUIRED_SCHEMA_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  sources: ["id", "kind", "identity_json", "latest_revision", "created_at"],
  source_snapshots: ["source_id", "revision", "observed_at", "duration_ms", "descriptor_json"],
  source_locators: ["source_id", "locator_digest", "private_reopen_locator", "observed_at"],
  investigations: ["id", "source_id", "source_revision", "duration_ms", "created_at", "updated_at"],
  transcript_tracks: ["id", "source_id", "source_revision", "language", "kind", "provider_track_id", "acquired_at", "metadata_json"],
  transcript_segments: ["id", "track_id", "start_ms", "end_ms", "text", "ordinal"],
  artifact_contents: ["id", "sha256", "byte_size", "blob_path", "mime_type", "created_at"],
  artifacts: ["record_key", "id", "source_id", "source_revision", "kind", "role", "mime_type", "sha256", "byte_size", "blob_path", "start_ms", "end_ms", "params_json", "producer_json", "created_at"],
  artifact_requests: ["request_key", "source_id", "source_revision", "operation", "artifact_record_key", "created_at"],
  artifact_derivations: ["artifact_id", "parent_artifact_id"],
  acquisitions: ["id", "source_id", "source_revision", "investigation_id", "operation", "request_key", "method", "status", "started_at", "completed_at", "wall_ms", "network_bytes", "network_accounting_complete", "error_code", "metadata_json"],
  presentations: ["id", "investigation_id", "artifact_id", "modality", "evidence_kind", "start_ms", "end_ms", "points_json", "metadata_json", "presented_at"],
  presentation_artifacts: ["presentation_id", "artifact_id"],
};

function currentSchemaMismatch(database: DatabaseSync): string | null {
  for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA_COLUMNS)) {
    const row = database
      .prepare("SELECT type FROM sqlite_master WHERE name=?")
      .get(table) as DbRow | undefined;
    if (row?.type !== "table") return `missing table ${table}`;
    const columns = new Set(
      (database.prepare(`PRAGMA table_info(${table})`).all() as DbRow[])
        .map((column) => String(column.name)),
    );
    const missing = requiredColumns.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      return `table ${table} is missing ${missing.join(", ")}`;
    }
  }
  return null;
}

function incompatibleSchema(message: string): UrmaError {
  return new UrmaError(
    "INTERNAL_ERROR",
    `Urma data directory has an incompatible schema (${message}); create a fresh data directory and reacquire evidence (existing files were not modified)`,
  );
}

function jsonObject(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new UrmaError(
      "INTERNAL_ERROR",
      `Persisted ${label} is invalid JSON; inspect or restore the Urma database`,
      { cause: error },
    );
  }
}

function points(value: unknown): number[] | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => !Number.isSafeInteger(item) || Number(item) < 0)
    ) {
      throw new Error("not millisecond points");
    }
    return parsed as number[];
  } catch (error) {
    throw new UrmaError(
      "INTERNAL_ERROR",
      "Persisted presentation points are invalid; inspect or restore the Urma database",
      { cause: error },
    );
  }
}

function sourceFromRow(row: DbRow): StoredSource {
  return {
    sourceRef: row.id as SourceRef,
    kind: row.kind as StoredSource["kind"],
    identity: jsonObject(row.identity_json, "source identity") as StoredSource["identity"],
    latestRevision: String(row.latest_revision),
    createdAt: String(row.created_at),
  };
}

function snapshotFromRow(row: DbRow): StoredSourceSnapshot {
  return {
    sourceRef: row.source_id as SourceRef,
    revision: String(row.revision),
    observedAt: String(row.observed_at),
    durationMs: Number(row.duration_ms),
    descriptor: jsonObject(row.descriptor_json, "source snapshot descriptor"),
  };
}

function locatorFromRow(row: DbRow): StoredSourceLocator {
  return {
    sourceRef: row.source_id as SourceRef,
    locatorDigest: String(row.locator_digest),
    privateReopenLocator: String(row.private_reopen_locator),
    observedAt: String(row.observed_at),
  };
}

function trackFromRow(row: DbRow): StoredTrack {
  return {
    id: String(row.id),
    sourceRef: row.source_id as SourceRef,
    sourceRevision: String(row.source_revision),
    language: String(row.language),
    kind: row.kind as StoredTrack["kind"],
    providerTrackId: row.provider_track_id === null
      ? null
      : String(row.provider_track_id),
    acquiredAt: String(row.acquired_at),
    metadata: jsonObject(row.metadata_json, "transcript track metadata"),
  };
}

function segmentFromRow(row: DbRow): StoredSegment {
  return {
    id: Number(row.id),
    trackId: String(row.track_id),
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    text: String(row.text),
    ordinal: Number(row.ordinal),
  };
}

function artifactFromRow(row: DbRow): StoredArtifact {
  return {
    artifactId: row.id as ArtifactId,
    sourceRef: row.source_id as SourceRef,
    sourceRevision: String(row.source_revision),
    kind: row.kind as StoredArtifact["kind"],
    role: row.role as StoredArtifact["role"],
    mimeType: String(row.mime_type),
    sha256: String(row.sha256),
    byteSize: Number(row.byte_size),
    blobPath: String(row.blob_path),
    startMs: row.start_ms === null ? null : Number(row.start_ms),
    endMs: row.end_ms === null ? null : Number(row.end_ms),
    params: jsonObject(row.params_json, "artifact parameters"),
    producer: jsonObject(row.producer_json, "artifact producer"),
    createdAt: String(row.created_at),
  };
}

function acquisitionFromRow(row: DbRow): StoredAcquisition {
  return {
    id: String(row.id),
    sourceRef: row.source_id as SourceRef,
    sourceRevision: String(row.source_revision),
    investigationRef: row.investigation_id === null
      ? null
      : (row.investigation_id as InvestigationRef),
    operation: String(row.operation),
    requestKey: String(row.request_key),
    method: row.method as StoredAcquisition["method"],
    status: row.status as StoredAcquisition["status"],
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    wallMs: row.wall_ms === null ? null : Number(row.wall_ms),
    networkBytes: row.network_bytes === null ? null : Number(row.network_bytes),
    networkAccountingComplete: Number(row.network_accounting_complete) === 1,
    errorCode: row.error_code === null ? null : String(row.error_code),
    metadata: jsonObject(row.metadata_json, "acquisition metadata"),
  };
}

function presentedArtifactIds(value: StoredPresentation): ArtifactId[] {
  const ids = new Set<ArtifactId>();
  if (value.artifactId) ids.add(value.artifactId);
  for (const field of ["artifactIds", "presentationArtifactIds"] as const) {
    const additional = value.metadata[field];
    if (additional !== undefined) {
      if (!Array.isArray(additional)) {
        throw new UrmaError(
          "CACHE_WRITE_FAILED",
          `Presentation ${field} metadata must be an array`,
        );
      }
      for (const candidate of additional) {
        if (typeof candidate !== "string") {
          throw new UrmaError(
            "CACHE_WRITE_FAILED",
            `Presentation ${field} metadata contains a non-string identifier`,
          );
        }
        try {
          ids.add(parseArtifactId(candidate));
        } catch (error) {
          throw new UrmaError(
            "CACHE_WRITE_FAILED",
            `Presentation ${field} metadata contains a malformed artifact identifier`,
            { cause: error },
          );
        }
      }
    }
  }
  return [...ids];
}

export class SqliteStore implements UrmaStore {
  readonly ftsEnabled: boolean;
  readonly #db: DatabaseSync;

  private constructor(databasePath: string) {
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;",
    );
    const schemaMarker = this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'")
      .get() as DbRow | undefined;
    if (!schemaMarker) {
      const existingTables = this.#all(
        this.#db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        ),
      );
      if (existingTables.length > 0) {
        this.#db.close();
        throw new UrmaError(
          "INTERNAL_ERROR",
          "Urma data directory contains an unversioned database; create a fresh data directory and reacquire evidence (existing files were not modified)",
        );
      }
      this.#transaction(() => {
        this.#db.exec("CREATE TABLE schema_meta (version INTEGER NOT NULL);");
        this.#db.exec(CURRENT_SCHEMA);
        this.#db
          .prepare("INSERT INTO schema_meta(version) VALUES(?)")
          .run(SCHEMA_VERSION);
      });
    } else {
      const schemaRows = this.#all(
        this.#db.prepare("SELECT version FROM schema_meta"),
      );
      const schemaRow = schemaRows[0];
      if (
        schemaRows.length !== 1 ||
        !schemaRow ||
        !Number.isSafeInteger(Number(schemaRow.version))
      ) {
        this.#db.close();
        throw incompatibleSchema("schema_meta has no single valid version");
      }
      const initialVersion = Number(schemaRow.version);
      if (initialVersion !== SCHEMA_VERSION) {
        this.#db.close();
        throw new UrmaError(
          "INTERNAL_ERROR",
          `Urma data directory uses unsupported schema ${initialVersion}; create a fresh data directory and reacquire evidence (existing files were not modified)`,
        );
      }
      const mismatch = currentSchemaMismatch(this.#db);
      if (mismatch) {
        this.#db.close();
        throw incompatibleSchema(mismatch);
      }
    }
    try {
      this.#db.exec(CREATE_FTS);
      this.ftsEnabled = true;
    } catch {
      this.ftsEnabled = false;
    }
  }

  static async open(databasePath: string): Promise<SqliteStore> {
    await mkdir(path.dirname(databasePath), { recursive: true });
    return new SqliteStore(databasePath);
  }

  close(): void {
    this.#db.close();
  }

  #transaction<T>(action: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }

  #all(statement: StatementSync, ...values: SQLInputValue[]): DbRow[] {
    return statement.all(...values) as DbRow[];
  }

  putSourceSnapshot(input: Readonly<{
    source: Omit<StoredSource, "createdAt">;
    snapshot: StoredSourceSnapshot;
    locators: readonly StoredSourceLocator[];
  }>): StoredSourceSnapshot {
    const { source, snapshot, locators } = input;
    if (source.sourceRef !== snapshot.sourceRef) {
      throw new UrmaError(
        "CACHE_WRITE_FAILED",
        "Source and snapshot identifiers must refer to the same logical source",
      );
    }
    if (source.latestRevision !== snapshot.revision) {
      throw new UrmaError(
        "CACHE_WRITE_FAILED",
        "Source latestRevision must point to the inserted snapshot revision",
      );
    }
    for (const locator of locators) {
      if (
        locator.sourceRef !== source.sourceRef ||
        !/^[0-9a-f]{64}$/u.test(locator.locatorDigest) ||
        locator.privateReopenLocator.length === 0
      ) {
        throw new UrmaError(
          "CACHE_WRITE_FAILED",
          "Source locator is malformed or belongs to another logical source",
        );
      }
    }
    const now = new Date().toISOString();
    this.#transaction(() => {
      const existingSource = this.#db
        .prepare("SELECT kind,identity_json FROM sources WHERE id=?")
        .get(source.sourceRef) as DbRow | undefined;
      if (
        existingSource &&
        (String(existingSource.kind) !== source.kind ||
          String(existingSource.identity_json) !== JSON.stringify(source.identity))
      ) {
        throw new UrmaError(
          "CACHE_WRITE_FAILED",
          `Logical source ${source.sourceRef} is immutable and conflicts with its existing identity`,
        );
      }
      this.#db
        .prepare(
          `INSERT INTO sources(id,kind,identity_json,latest_revision,created_at)
           VALUES(?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,identity_json=excluded.identity_json,latest_revision=excluded.latest_revision`,
        )
        .run(
          source.sourceRef,
          source.kind,
          JSON.stringify(source.identity),
          source.latestRevision,
          now,
        );
      this.#db
        .prepare(
          `INSERT INTO source_snapshots(source_id,revision,observed_at,duration_ms,descriptor_json)
           VALUES(?,?,?,?,?)
           ON CONFLICT(source_id,revision) DO NOTHING`,
        )
        .run(
          snapshot.sourceRef,
          snapshot.revision,
          snapshot.observedAt,
          snapshot.durationMs,
          JSON.stringify(snapshot.descriptor),
        );
      const stored = this.#db
        .prepare(
          "SELECT * FROM source_snapshots WHERE source_id=? AND revision=?",
        )
        .get(snapshot.sourceRef, snapshot.revision) as DbRow | undefined;
      if (!stored) {
        throw new UrmaError(
          "CACHE_WRITE_FAILED",
          "Source snapshot could not be read back after insertion",
        );
      }
      if (
        Number(stored.duration_ms) !== snapshot.durationMs ||
        String(stored.observed_at) !== snapshot.observedAt ||
        String(stored.descriptor_json) !== JSON.stringify(snapshot.descriptor)
      ) {
        throw new UrmaError(
          "CACHE_WRITE_FAILED",
          `Source snapshot ${snapshot.revision} is immutable and conflicts with an existing observation`,
        );
      }
      const putLocator = this.#db.prepare(
        `INSERT INTO source_locators(source_id,locator_digest,private_reopen_locator,observed_at)
         VALUES(?,?,?,?) ON CONFLICT(source_id,locator_digest) DO NOTHING`,
      );
      for (const locator of locators) {
        putLocator.run(
          locator.sourceRef,
          locator.locatorDigest,
          locator.privateReopenLocator,
          locator.observedAt,
        );
        const storedLocator = this.#db
          .prepare(
            "SELECT private_reopen_locator FROM source_locators WHERE source_id=? AND locator_digest=?",
          )
          .get(locator.sourceRef, locator.locatorDigest) as DbRow | undefined;
        if (!storedLocator || String(storedLocator.private_reopen_locator) !== locator.privateReopenLocator) {
          throw new UrmaError(
            "CACHE_WRITE_FAILED",
            `Source locator ${locator.locatorDigest} is immutable and conflicts with an existing private locator`,
          );
        }
        this.#db
          .prepare(
            "UPDATE source_locators SET observed_at=? WHERE source_id=? AND locator_digest=?",
          )
          .run(locator.observedAt, locator.sourceRef, locator.locatorDigest);
      }
    });
    return this.getSnapshot(snapshot.sourceRef, snapshot.revision)!;
  }

  getSource(sourceRef: SourceRef): StoredSource | null {
    const row = this.#db
      .prepare("SELECT * FROM sources WHERE id=?")
      .get(sourceRef) as DbRow | undefined;
    return row ? sourceFromRow(row) : null;
  }
  getSnapshot(sourceRef: SourceRef, revision: string): StoredSourceSnapshot | null {
    const row = this.#db
      .prepare(
        "SELECT * FROM source_snapshots WHERE source_id=? AND revision=?",
      )
      .get(sourceRef, revision) as DbRow | undefined;
    return row ? snapshotFromRow(row) : null;
  }
  getLatestSnapshot(sourceRef: SourceRef): StoredSourceSnapshot | null {
    const source = this.getSource(sourceRef);
    if (!source) return null;
    return this.getSnapshot(sourceRef, source.latestRevision);
  }
  getLocator(sourceRef: SourceRef, locatorDigest: string): StoredSourceLocator | null {
    const row = this.#db
      .prepare(
        "SELECT * FROM source_locators WHERE source_id=? AND locator_digest=?",
      )
      .get(sourceRef, locatorDigest) as DbRow | undefined;
    return row ? locatorFromRow(row) : null;
  }
  listSourceLocators(sourceRef: SourceRef): StoredSourceLocator[] {
    return this.#all(
      this.#db.prepare(
        "SELECT * FROM source_locators WHERE source_id=? ORDER BY observed_at,locator_digest",
      ),
      sourceRef,
    ).map(locatorFromRow);
  }
  findSourcesByLocatorDigest(locatorDigest: string): StoredSource[] {
    return this.#all(
      this.#db.prepare(
        `SELECT sources.* FROM sources
         INNER JOIN source_locators ON source_locators.source_id = sources.id
         WHERE source_locators.locator_digest=?
         ORDER BY sources.id`,
      ),
      locatorDigest,
    ).map(sourceFromRow);
  }

  createInvestigation(value: StoredInvestigation): void {
    this.#transaction(() => {
      const snapshot = this.getSnapshot(value.sourceRef, value.sourceRevision);
      if (!snapshot) {
        throw new UrmaError(
          "CACHE_WRITE_FAILED",
          `Investigation ${value.investigationRef} references an unknown source snapshot`,
        );
      }
      if (snapshot.durationMs !== value.durationMs) {
        throw new UrmaError(
          "CACHE_WRITE_FAILED",
          `Investigation ${value.investigationRef} duration does not match its pinned source snapshot`,
        );
      }
      this.#db
        .prepare(
          "INSERT INTO investigations(id,source_id,source_revision,duration_ms,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          value.investigationRef,
          value.sourceRef,
          value.sourceRevision,
          value.durationMs,
          value.createdAt,
          value.updatedAt,
        );
    });
  }

  getInvestigation(ref: InvestigationRef): StoredInvestigation | null {
    const row = this.#db
      .prepare("SELECT * FROM investigations WHERE id=?")
      .get(ref) as DbRow | undefined;
    return row
      ? {
        investigationRef: row.id as InvestigationRef,
        sourceRef: row.source_id as SourceRef,
        sourceRevision: String(row.source_revision),
        durationMs: Number(row.duration_ms),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }
      : null;
  }

  putTranscript(
    track: StoredTrack,
    segments: readonly Omit<StoredSegment, "id">[],
  ): void {
    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO transcript_tracks(id,source_id,source_revision,language,kind,provider_track_id,acquired_at,metadata_json) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET acquired_at=excluded.acquired_at,metadata_json=excluded.metadata_json`,
        )
        .run(
          track.id,
          track.sourceRef,
          track.sourceRevision,
          track.language,
          track.kind,
          track.providerTrackId,
          track.acquiredAt,
          JSON.stringify(track.metadata),
        );
      if (this.ftsEnabled) {
        this.#db
          .prepare("DELETE FROM transcript_fts WHERE track_id=?")
          .run(track.id);
      }
      this.#db
        .prepare("DELETE FROM transcript_segments WHERE track_id=?")
        .run(track.id);
      const insert = this.#db.prepare(
        "INSERT INTO transcript_segments(track_id,start_ms,end_ms,text,ordinal) VALUES(?,?,?,?,?)",
      );
      const insertFts = this.ftsEnabled
        ? this.#db.prepare(
          "INSERT INTO transcript_fts(text,track_id,segment_id) VALUES(?,?,?)",
        )
        : null;
      for (const segment of segments) {
        const result = insert.run(
          track.id,
          segment.startMs,
          segment.endMs,
          segment.text,
          segment.ordinal,
        );
        insertFts?.run(segment.text, track.id, Number(result.lastInsertRowid));
      }
    });
  }

  listTranscriptTracks(sourceRef: SourceRef, revision: string): StoredTrack[] {
    return this.#all(
      this.#db.prepare(
        "SELECT * FROM transcript_tracks WHERE source_id=? AND source_revision=? ORDER BY language,kind,id",
      ),
      sourceRef,
      revision,
    ).map(trackFromRow);
  }
  listTranscriptSegments(
    trackId: string,
    startMs = 0,
    endMs = Number.MAX_SAFE_INTEGER,
  ): StoredSegment[] {
    return this.#all(
      this.#db.prepare(
        "SELECT * FROM transcript_segments WHERE track_id=? AND end_ms>? AND start_ms<? ORDER BY ordinal",
      ),
      trackId,
      startMs,
      endMs,
    ).map(segmentFromRow);
  }

  // Probe FTS capability at the storage layer only
  // EvidenceService uses the bounded fallback because LIMIT cannot prove completeness
  searchTranscriptSegments(
    trackId: string,
    query: string,
    limit: number,
  ): StoredSegment[] {
    if (this.ftsEnabled) {
      try {
        return this.#all(
          this.#db.prepare(
            `SELECT s.* FROM transcript_fts f JOIN transcript_segments s ON s.id=f.segment_id WHERE f.track_id=? AND transcript_fts MATCH ? ORDER BY rank,s.ordinal LIMIT ?`,
          ),
          trackId,
          query,
          limit,
        ).map(segmentFromRow);
      } catch {
        /* use the deterministic fallback for punctuation-heavy literal queries */
      }
    }
    const needle = query.normalize("NFKC").toLowerCase();
    return this.listTranscriptSegments(trackId)
      .filter((segment) =>
        segment.text.normalize("NFKC").toLowerCase().includes(needle)
      )
      .slice(0, limit);
  }

  putArtifact(
    artifact: StoredArtifact,
    request?: Readonly<{ requestKey: string; operation: string }>,
    parents: readonly ArtifactId[] = [],
  ): void {
    this.#transaction(() => {
      if (artifactHashFromId(artifact.artifactId) !== artifact.sha256) {
        throw new UrmaError(
          "CACHE_WRITE_FAILED",
          `Artifact ID does not match declared SHA-256 for ${artifact.artifactId}`,
        );
      }
      this.#db
        .prepare(
          "INSERT OR IGNORE INTO artifact_contents(id,sha256,byte_size,blob_path,mime_type,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          artifact.artifactId,
          artifact.sha256,
          artifact.byteSize,
          artifact.blobPath,
          artifact.mimeType,
          artifact.createdAt,
        );
      const content = this.#db
        .prepare(
          "SELECT sha256,byte_size,blob_path FROM artifact_contents WHERE id=?",
        )
        .get(artifact.artifactId) as DbRow | undefined;
      if (
        !content ||
        content.sha256 !== artifact.sha256 ||
        Number(content.byte_size) !== artifact.byteSize ||
        content.blob_path !== artifact.blobPath
      ) {
        throw new UrmaError(
          "CACHE_WRITE_FAILED",
          `Artifact content metadata conflicts with existing immutable content ${artifact.artifactId}`,
        );
      }
      const recordKey = hashText(
        stableJson({
          artifactId: artifact.artifactId,
          sourceRef: artifact.sourceRef,
          sourceRevision: artifact.sourceRevision,
          kind: artifact.kind,
          role: artifact.role,
          startMs: artifact.startMs,
          endMs: artifact.endMs,
          params: artifact.params,
          producer: artifact.producer,
        }),
      );
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO artifacts(record_key,id,source_id,source_revision,kind,role,mime_type,sha256,byte_size,blob_path,start_ms,end_ms,params_json,producer_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          recordKey,
          artifact.artifactId,
          artifact.sourceRef,
          artifact.sourceRevision,
          artifact.kind,
          artifact.role,
          artifact.mimeType,
          artifact.sha256,
          artifact.byteSize,
          artifact.blobPath,
          artifact.startMs,
          artifact.endMs,
          JSON.stringify(artifact.params),
          JSON.stringify(artifact.producer),
          artifact.createdAt,
        );
      if (request) {
        this.#db
          .prepare(
            "INSERT OR REPLACE INTO artifact_requests(request_key,source_id,source_revision,operation,artifact_record_key,created_at) VALUES(?,?,?,?,?,?)",
          )
          .run(
            request.requestKey,
            artifact.sourceRef,
            artifact.sourceRevision,
            request.operation,
            recordKey,
            artifact.createdAt,
          );
      }
      const derive = this.#db.prepare(
        "INSERT OR IGNORE INTO artifact_derivations(artifact_id,parent_artifact_id) VALUES(?,?)",
      );
      for (const parent of parents) derive.run(artifact.artifactId, parent);
    });
  }

  getArtifact(id: ArtifactId): StoredArtifact | null {
    const row = this.#db
      .prepare(
        "SELECT * FROM artifacts WHERE id=? ORDER BY created_at,record_key LIMIT 1",
      )
      .get(id) as DbRow | undefined;
    return row ? artifactFromRow(row) : null;
  }
  getArtifactByRequest(key: string): StoredArtifact | null {
    const row = this.#db
      .prepare(
        "SELECT a.* FROM artifact_requests r JOIN artifacts a ON a.record_key=r.artifact_record_key WHERE r.request_key=?",
      )
      .get(key) as DbRow | undefined;
    return row ? artifactFromRow(row) : null;
  }
  listArtifacts(ref: SourceRef, revision: string): StoredArtifact[] {
    return this.#all(
      this.#db.prepare(
        "SELECT * FROM artifacts WHERE source_id=? AND source_revision=? ORDER BY created_at",
      ),
      ref,
      revision,
    ).map(artifactFromRow);
  }

  beginAcquisition(value: StoredAcquisition): void {
    this.#db
      .prepare(
        `INSERT INTO acquisitions(id,source_id,source_revision,investigation_id,operation,request_key,method,status,started_at,completed_at,wall_ms,network_bytes,network_accounting_complete,error_code,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        value.id,
        value.sourceRef,
        value.sourceRevision,
        value.investigationRef,
        value.operation,
        value.requestKey,
        value.method,
        value.status,
        value.startedAt,
        value.completedAt,
        value.wallMs,
        value.networkBytes,
        value.networkAccountingComplete ? 1 : 0,
        value.errorCode,
        JSON.stringify(value.metadata),
      );
  }
  finishAcquisition(
    id: string,
    value: Pick<
      StoredAcquisition,
      | "status"
      | "completedAt"
      | "wallMs"
      | "networkBytes"
      | "networkAccountingComplete"
      | "errorCode"
      | "metadata"
    >,
  ): void {
    this.#db
      .prepare(
        "UPDATE acquisitions SET status=?,completed_at=?,wall_ms=?,network_bytes=?,network_accounting_complete=?,error_code=?,metadata_json=? WHERE id=?",
      )
      .run(
        value.status,
        value.completedAt,
        value.wallMs,
        value.networkBytes,
        value.networkAccountingComplete ? 1 : 0,
        value.errorCode,
        JSON.stringify(value.metadata),
        id,
      );
  }
  listAcquisitions(ref: InvestigationRef): StoredAcquisition[] {
    return this.#all(
      this.#db.prepare(
        "SELECT * FROM acquisitions WHERE investigation_id=? ORDER BY started_at,id",
      ),
      ref,
    ).map(acquisitionFromRow);
  }

  addPresentation(value: StoredPresentation): void {
    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO presentations(id,investigation_id,artifact_id,modality,evidence_kind,start_ms,end_ms,points_json,metadata_json,presented_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          value.id,
          value.investigationRef,
          value.artifactId,
          value.modality,
          value.evidenceKind,
          value.startMs,
          value.endMs,
          value.pointsMs === null ? null : JSON.stringify(value.pointsMs),
          JSON.stringify(value.metadata),
          value.presentedAt,
        );
      const insert = this.#db.prepare(
        "INSERT INTO presentation_artifacts(presentation_id,artifact_id) VALUES(?,?)",
      );
      for (const artifactId of presentedArtifactIds(value)) {
        insert.run(value.id, artifactId);
      }
    });
  }
  listPresentations(ref: InvestigationRef): StoredPresentation[] {
    return this.#all(
      this.#db.prepare(
        "SELECT * FROM presentations WHERE investigation_id=? ORDER BY presented_at,id",
      ),
      ref,
    ).map((row) => ({
      id: String(row.id),
      investigationRef: row.investigation_id as InvestigationRef,
      artifactId: row.artifact_id === null
        ? null
        : (row.artifact_id as ArtifactId),
      modality: row.modality as StoredPresentation["modality"],
      evidenceKind: row.evidence_kind as StoredPresentation["evidenceKind"],
      startMs: row.start_ms === null ? null : Number(row.start_ms),
      endMs: row.end_ms === null ? null : Number(row.end_ms),
      pointsMs: points(row.points_json),
      metadata: jsonObject(row.metadata_json, "presentation metadata"),
      presentedAt: String(row.presented_at),
    }));
  }
  isArtifactPresented(ref: InvestigationRef, artifactId: ArtifactId): boolean {
    return (
      this.#db
        .prepare(
          "SELECT 1 FROM presentation_artifacts pa JOIN presentations p ON p.id=pa.presentation_id WHERE p.investigation_id=? AND pa.artifact_id=? LIMIT 1",
        )
        .get(ref, artifactId) !== undefined
    );
  }
  listPresentedArtifactIds(ref: InvestigationRef): ArtifactId[] {
    return this.#all(
      this.#db.prepare(
        "SELECT DISTINCT pa.artifact_id FROM presentation_artifacts pa JOIN presentations p ON p.id=pa.presentation_id WHERE p.investigation_id=? ORDER BY pa.artifact_id",
      ),
      ref,
    ).map((row) => row.artifact_id as ArtifactId);
  }

  cacheStats(): {
    sources: number;
    investigations: number;
    artifacts: number;
    artifactBytes: number;
    acquisitions: number;
  } {
    const scalar = (sql: string) =>
      Number((this.#db.prepare(sql).get() as DbRow).value);
    return {
      sources: scalar("SELECT count(*) value FROM sources"),
      investigations: scalar("SELECT count(*) value FROM investigations"),
      artifacts: scalar("SELECT count(*) value FROM artifact_contents"),
      artifactBytes: scalar(
        "SELECT coalesce(sum(byte_size),0) value FROM artifact_contents",
      ),
      acquisitions: scalar("SELECT count(*) value FROM acquisitions"),
    };
  }
}
