import type { EdgeRelation, ExtractionCallbacks, NodeRow } from "./types.js";

export class CompositeCallbacks implements ExtractionCallbacks {
  constructor(private readonly delegates: readonly ExtractionCallbacks[]) {}

  insertNode(row: NodeRow): void {
    for (const delegate of this.delegates) delegate.insertNode(row);
  }

  insertEdge(sourceId: string, targetId: string, relation: EdgeRelation): void {
    for (const delegate of this.delegates) delegate.insertEdge(sourceId, targetId, relation);
  }
}

export class SourceNodeBuffer implements ExtractionCallbacks {
  private readonly rowsBySource = new Map<string, NodeRow[]>();
  private currentSource: string | null = null;

  begin(sourceFilePath: string): NodeRow[] {
    const previous = this.rowsBySource.get(sourceFilePath) ?? [];
    this.rowsBySource.set(sourceFilePath, []);
    this.currentSource = sourceFilePath;
    return previous;
  }

  end(): void {
    this.currentSource = null;
  }

  remove(sourceFilePath: string): NodeRow[] {
    const previous = this.rowsBySource.get(sourceFilePath) ?? [];
    this.rowsBySource.delete(sourceFilePath);
    return previous;
  }

  restore(sourceFilePath: string, rows: readonly NodeRow[]): void {
    this.rowsBySource.set(sourceFilePath, [...rows]);
  }

  get(sourceFilePath: string): readonly NodeRow[] {
    return this.rowsBySource.get(sourceFilePath) ?? [];
  }

  all(): NodeRow[] {
    return [...this.rowsBySource.values()].flat();
  }

  clear(): void {
    this.rowsBySource.clear();
    this.currentSource = null;
  }

  insertNode(row: NodeRow): void {
    if (!this.currentSource) throw new Error("SourceNodeBuffer.begin() no fue invocado");
    this.rowsBySource.get(this.currentSource)!.push(row);
  }

  insertEdge(_sourceId: string, _targetId: string, _relation: EdgeRelation): void {}
}
