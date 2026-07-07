CREATE TABLE IF NOT EXISTS graph_state (
  id         INTEGER PRIMARY KEY CHECK(id = 1),
  revision   TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO graph_state(id, revision, updated_at)
VALUES (1, 'unversioned', datetime('now'));

CREATE TABLE IF NOT EXISTS semantic_profile_builds (
  id                TEXT PRIMARY KEY,
  status            TEXT NOT NULL CHECK(status IN ('building', 'ready', 'error')),
  graph_revision    TEXT NOT NULL,
  evidence_revision TEXT NOT NULL,
  model             TEXT NOT NULL,
  prompt_version    INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  completed_at      TEXT,
  error             TEXT
);

CREATE TABLE IF NOT EXISTS semantic_profile_state (
  id              INTEGER PRIMARY KEY CHECK(id = 1),
  active_build_id TEXT,
  status          TEXT NOT NULL CHECK(status IN ('missing', 'building', 'ready', 'stale', 'error')),
  last_error      TEXT,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY(active_build_id) REFERENCES semantic_profile_builds(id)
);

INSERT OR IGNORE INTO semantic_profile_state(id, active_build_id, status, last_error, updated_at)
VALUES (1, NULL, 'missing', NULL, datetime('now'));

CREATE TABLE IF NOT EXISTS semantic_domains (
  name        TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS semantic_terms (
  build_id        TEXT NOT NULL,
  id              TEXT NOT NULL,
  canonical_term  TEXT NOT NULL,
  normalized_term TEXT NOT NULL,
  kind            TEXT NOT NULL,
  node_id         TEXT,
  path            TEXT,
  description     TEXT NOT NULL,
  dimensions_json TEXT NOT NULL,
  evidence_json   TEXT NOT NULL,
  confidence      REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  source_hash     TEXT NOT NULL,
  PRIMARY KEY(build_id, id),
  FOREIGN KEY(build_id) REFERENCES semantic_profile_builds(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_semantic_terms_build ON semantic_terms(build_id);
CREATE INDEX IF NOT EXISTS idx_semantic_terms_node ON semantic_terms(node_id);

CREATE TABLE IF NOT EXISTS semantic_aliases (
  build_id         TEXT NOT NULL,
  term_id          TEXT NOT NULL,
  value            TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  language         TEXT NOT NULL CHECK(language IN ('es', 'en', 'unknown')),
  confidence       REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  PRIMARY KEY(build_id, term_id, normalized_value),
  FOREIGN KEY(build_id, term_id) REFERENCES semantic_terms(build_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_semantic_aliases_build ON semantic_aliases(build_id);

CREATE TABLE IF NOT EXISTS semantic_term_domains (
  build_id TEXT NOT NULL,
  term_id  TEXT NOT NULL,
  domain   TEXT NOT NULL,
  score    REAL NOT NULL CHECK(score >= 0 AND score <= 1),
  PRIMARY KEY(build_id, term_id, domain),
  FOREIGN KEY(build_id, term_id) REFERENCES semantic_terms(build_id, id) ON DELETE CASCADE,
  FOREIGN KEY(domain) REFERENCES semantic_domains(name)
);

CREATE VIRTUAL TABLE IF NOT EXISTS semantic_profile_fts USING fts5(
  build_id UNINDEXED,
  term_id UNINDEXED,
  canonical_term,
  aliases,
  description,
  path,
  domains
);
