/** Current pre-launch storage contract; older local data is invalidated */
export const SCHEMA_VERSION = 5;

export const CURRENT_SCHEMA = `
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('remote','local')),
  identity_json TEXT NOT NULL,
  latest_revision TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE source_snapshots (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  descriptor_json TEXT NOT NULL,
  PRIMARY KEY (source_id, revision)
);
CREATE INDEX source_snapshots_latest ON source_snapshots(source_id, revision);

CREATE TABLE source_locators (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  locator_digest TEXT NOT NULL CHECK (length(locator_digest) = 64),
  private_reopen_locator TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (source_id, locator_digest)
);
CREATE INDEX source_locator_lookup ON source_locators(locator_digest, source_id);

CREATE TABLE investigations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_id, source_revision)
    REFERENCES source_snapshots(source_id, revision)
);
CREATE INDEX investigations_source ON investigations(source_id, source_revision, created_at);

CREATE TABLE transcript_tracks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  language TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manual','automatic','sidecar','unknown')),
  provider_track_id TEXT,
  acquired_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  FOREIGN KEY (source_id, source_revision)
    REFERENCES source_snapshots(source_id, revision)
);

CREATE TABLE transcript_segments (
  id INTEGER PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES transcript_tracks(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
  text TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  UNIQUE(track_id, ordinal)
);
CREATE INDEX transcript_segments_time ON transcript_segments(track_id, start_ms, end_ms);

CREATE TABLE artifact_contents (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  blob_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  record_key TEXT PRIMARY KEY,
  id TEXT NOT NULL REFERENCES artifact_contents(id),
  source_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  kind TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('locator','transport','evidence')),
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  blob_path TEXT NOT NULL,
  start_ms INTEGER,
  end_ms INTEGER,
  params_json TEXT NOT NULL,
  producer_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((start_ms IS NULL AND end_ms IS NULL) OR (start_ms IS NOT NULL AND end_ms IS NOT NULL AND start_ms <= end_ms)),
  FOREIGN KEY (source_id, source_revision)
    REFERENCES source_snapshots(source_id, revision)
);
CREATE INDEX artifacts_source ON artifacts(source_id, source_revision, kind);
CREATE INDEX artifacts_content ON artifacts(id);

CREATE TABLE artifact_requests (
  request_key TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  operation TEXT NOT NULL,
  artifact_record_key TEXT NOT NULL REFERENCES artifacts(record_key),
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_id, source_revision)
    REFERENCES source_snapshots(source_id, revision)
);

CREATE TABLE artifact_derivations (
  artifact_id TEXT NOT NULL REFERENCES artifact_contents(id) ON DELETE CASCADE,
  parent_artifact_id TEXT NOT NULL REFERENCES artifact_contents(id),
  PRIMARY KEY (artifact_id, parent_artifact_id)
);

CREATE TABLE acquisitions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  investigation_id TEXT REFERENCES investigations(id),
  operation TEXT NOT NULL,
  request_key TEXT NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  wall_ms INTEGER,
  network_bytes INTEGER,
  network_accounting_complete INTEGER NOT NULL CHECK (network_accounting_complete IN (0,1)),
  error_code TEXT,
  metadata_json TEXT NOT NULL,
  CHECK (network_bytes IS NULL OR network_bytes >= 0),
  FOREIGN KEY (source_id, source_revision)
    REFERENCES source_snapshots(source_id, revision)
);
CREATE INDEX acquisitions_investigation ON acquisitions(investigation_id, started_at);
CREATE INDEX acquisitions_request ON acquisitions(source_id, source_revision, request_key);

CREATE TABLE presentations (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  artifact_id TEXT REFERENCES artifact_contents(id),
  modality TEXT NOT NULL CHECK (modality IN ('transcript','visual','audio')),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('transcript_search','transcript_range','point','sparse','ordered_points','audio')),
  start_ms INTEGER,
  end_ms INTEGER,
  points_json TEXT,
  metadata_json TEXT NOT NULL,
  presented_at TEXT NOT NULL,
  CHECK ((start_ms IS NULL AND end_ms IS NULL) OR (start_ms IS NOT NULL AND end_ms IS NOT NULL AND start_ms <= end_ms))
);
CREATE INDEX presentations_investigation ON presentations(investigation_id, presented_at);

CREATE TABLE presentation_artifacts (
  presentation_id TEXT NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifact_contents(id),
  PRIMARY KEY (presentation_id, artifact_id)
);
CREATE INDEX presentation_artifacts_authorization ON presentation_artifacts(artifact_id, presentation_id);
`;

export const CREATE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
  text,
  track_id UNINDEXED,
  segment_id UNINDEXED,
  tokenize='unicode61 remove_diacritics 2'
);
`;
