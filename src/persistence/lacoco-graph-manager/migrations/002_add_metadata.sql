-- Tabla de metadatos para acelerar filtrado dimensional
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
