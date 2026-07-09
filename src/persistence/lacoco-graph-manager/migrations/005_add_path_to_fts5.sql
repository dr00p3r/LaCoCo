-- FTS5 con columna `path`: queries orientadas a módulo/archivo.
--
-- Las migraciones previas (001, 003) indexaban solo (node_id, name, signature).
-- Queries del estilo "el path strategies", "el módulo de retrieval" no
-- encontraban el `filepath` del nodo via BM25 — el FTS5 retornaba 0 hits y el
-- ranking se sostenía solo en ANN. Añadir `path` al FTS5 hace que esas queries
-- rescaten el nodo por la ruta del archivo antes de que ANN decida.
--
-- FTS5 no soporta ALTER TABLE, así que la migración es destructiva sobre
-- `nodes_fts`: DROP + CREATE + reindex desde `nodes`. El cost es ~10-50 ms
-- por cada 1000 nodos; se ejecuta una sola vez por proyecto.
DROP TABLE IF EXISTS nodes_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  node_id,
  name,
  signature,
  path
);

-- Reindex: copia name+signature+filepath de cada nodo al FTS5.
INSERT INTO nodes_fts(node_id, name, signature, path)
SELECT id, name, signature, filepath FROM nodes;

-- Triggers para mantener FTS sincronizado por id estable.
DROP TRIGGER IF EXISTS nodes_fts_insert;
DROP TRIGGER IF EXISTS nodes_fts_delete;
DROP TRIGGER IF EXISTS nodes_fts_update;

CREATE TRIGGER nodes_fts_insert AFTER INSERT ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = new.id;
  INSERT INTO nodes_fts(node_id, name, signature, path)
  VALUES (new.id, new.name, new.signature, new.filepath);
END;

CREATE TRIGGER nodes_fts_delete AFTER DELETE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = old.id;
END;

CREATE TRIGGER nodes_fts_update AFTER UPDATE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE node_id = old.id OR node_id = new.id;
  INSERT INTO nodes_fts(node_id, name, signature, path)
  VALUES (new.id, new.name, new.signature, new.filepath);
END;
