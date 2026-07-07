import { SemanticProfileStore } from "./semantic-profile-store.js";
import type { QueryGrounding } from "./types.js";

export interface QueryGrounderOptions {
  topTerms?: number;
  topDomains?: number;
}

export class QueryGrounder {
  constructor(private readonly store: SemanticProfileStore) {}

  ground(query: string, options: QueryGrounderOptions = {}): QueryGrounding {
    return this.store.groundQuery(
      query,
      options.topTerms ?? 20,
      options.topDomains ?? 3,
    );
  }
}
