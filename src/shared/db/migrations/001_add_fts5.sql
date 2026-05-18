-- Extensión FTS5 para búsqueda BM25 sobre nodos
-- Tabla virtual independiente (sin content=) para mayor compatibilidad.
-- node_id se almacena como columna regular para facilitar JOINs.
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  node_id,
  name,
  signature
);

-- Trigger para mantener FTS sincronizado
CREATE TRIGGER IF NOT EXISTS nodes_fts_insert AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(node_id, name, signature)
  VALUES (new.id, new.name, new.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_delete AFTER DELETE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_update AFTER UPDATE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE rowid = old.rowid;
  INSERT INTO nodes_fts(node_id, name, signature)
  VALUES (new.id, new.name, new.signature);
END;
