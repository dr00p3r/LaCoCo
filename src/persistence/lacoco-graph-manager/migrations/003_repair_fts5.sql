DROP TRIGGER IF EXISTS nodes_fts_insert;
DROP TRIGGER IF EXISTS nodes_fts_delete;
DROP TRIGGER IF EXISTS nodes_fts_update;

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  node_id,
  name,
  signature
);

CREATE TABLE IF NOT EXISTS node_metadata (
  node_id TEXT PRIMARY KEY,
  dimension TEXT CHECK(dimension IN ('SYS','CPG','DTG')),
  sub_type TEXT,
  package_name TEXT,
  package_version TEXT,
  FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_node_metadata_dim ON node_metadata(dimension);
CREATE INDEX IF NOT EXISTS idx_node_metadata_pkg ON node_metadata(package_name);

DELETE FROM nodes_fts;
INSERT INTO nodes_fts(node_id, name, signature)
SELECT id, name, signature FROM nodes;

CREATE TRIGGER nodes_fts_insert AFTER INSERT ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = new.id;
  INSERT INTO nodes_fts(node_id, name, signature)
  VALUES (new.id, new.name, new.signature);
END;

CREATE TRIGGER nodes_fts_delete AFTER DELETE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = old.id;
END;

CREATE TRIGGER nodes_fts_update AFTER UPDATE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = old.id OR node_id = new.id;
  INSERT INTO nodes_fts(node_id, name, signature)
  VALUES (new.id, new.name, new.signature);
END;
