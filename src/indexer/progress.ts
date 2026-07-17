/**
 * Callback de progreso opcional para los indexadores. Permite que el CLI
 * refleje el avance por-archivo en el HUD sin acoplar los indexadores a la
 * capa de presentación. Por defecto los indexadores usan un no-op.
 */
export interface IndexProgressEvent {
  /** Archivos procesados hasta ahora. */
  current: number;
  /** Total de archivos conocidos hasta ahora (crece al cargar cada proyecto). */
  total: number;
  /** Nodos escritos acumulados (si el indexador los cuenta). */
  nodes?: number;
  /** Aristas escritas acumuladas (si el indexador las cuenta). */
  edges?: number;
}

export type IndexProgress = (event: IndexProgressEvent) => void;

export const NOOP_PROGRESS: IndexProgress = () => {};
