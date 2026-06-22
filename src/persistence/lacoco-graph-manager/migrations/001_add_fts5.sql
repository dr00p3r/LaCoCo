-- Extensión FTS5 para búsqueda BM25 sobre nodos
-- Tabla virtual independiente (sin content=) para mayor compatibilidad.
-- node_id se almacena como columna regular para facilitar JOINs.
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  node_id,
  name,
  signature
);

-- Triggers para mantener FTS sincronizado por id estable.
DROP TRIGGER IF EXISTS nodes_fts_insert;
DROP TRIGGER IF EXISTS nodes_fts_delete;
DROP TRIGGER IF EXISTS nodes_fts_update;

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
