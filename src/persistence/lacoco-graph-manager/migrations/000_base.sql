-- Schema base: tablas nodes y edges con índices
CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT    PRIMARY KEY,
  kind         TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  filepath     TEXT    NOT NULL,
  signature    TEXT,
  isDeprecated INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_nodes_filepath ON nodes(filepath);

CREATE TABLE IF NOT EXISTS edges (
  sourceId TEXT NOT NULL,
  targetId TEXT NOT NULL,
  relation TEXT NOT NULL,
  UNIQUE(sourceId, targetId, relation),
  FOREIGN KEY(sourceId) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(sourceId);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(targetId);
