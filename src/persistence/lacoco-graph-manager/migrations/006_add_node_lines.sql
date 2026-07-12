-- Rangos de línea del símbolo declarante, para servir el CUERPO del código
-- (no solo la firma) leyéndolo perezosamente del working tree en retrieve-time.
--
-- No se guarda el cuerpo en la BDD: solo las líneas. El cuerpo se corta del
-- archivo en disco al recuperar (ChunkBodyResolver), así queda siempre fresco
-- con el árbol de trabajo y la BDD se mantiene pequeña.
--
-- NULL = nodo indexado antes de esta migración (reindexar lo puebla) o símbolo
-- sin span propio (p.ej. EXTERNAL_LIB, que vive en node_modules y no se sirve).
-- En ambos casos el resolver cae de vuelta a la firma.
ALTER TABLE nodes ADD COLUMN startLine INTEGER;
ALTER TABLE nodes ADD COLUMN endLine INTEGER;
