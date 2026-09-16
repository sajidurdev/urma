/** Shared transcript-search ceilings for the Evidence API and MCP schema */
export const MAX_TRANSCRIPT_QUERY_CHARACTERS = 256;
export const MAX_TRANSCRIPT_SEARCH_RESULTS = 20;
export const DEFAULT_TRANSCRIPT_SEARCH_RESULTS = 5;
export const MAX_TRANSCRIPT_BATCH_QUERIES = 20;
export const MAX_TRANSCRIPT_BATCH_HITS = 20;
export const MAX_TRANSCRIPT_BATCH_CHARACTERS = 16_000;
/** Search inspects at most this many matching segments per query before bounded truncation */
export const MAX_TRANSCRIPT_SEARCH_CANDIDATES = MAX_TRANSCRIPT_SEARCH_RESULTS *
  10;
/** Search does not scan an arbitrarily large track to prove completeness */
export const MAX_TRANSCRIPT_SEARCH_SEGMENTS = 10_000;
