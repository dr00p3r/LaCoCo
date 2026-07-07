import type { SemanticDomain } from "./types.js";

export const SEMANTIC_DOMAIN_DESCRIPTIONS: Readonly<Record<SemanticDomain, string>> = {
  "ui-style": "Visual styles, themes, colors, CSS and design tokens.",
  "ui-components": "User-interface components, views and interaction elements.",
  routing: "Application routes, navigation and request routing.",
  api: "HTTP APIs, controllers, clients and transport contracts.",
  auth: "Authentication, authorization, sessions and identity.",
  "db-persistence": "Databases, repositories, schemas, entities and migrations.",
  "business-logic": "Domain rules, services and application behavior.",
  validation: "Input validation, DTO constraints and schemas.",
  "state-management": "Application state, stores, reducers and reactive state.",
  testing: "Tests, fixtures, mocks and test infrastructure.",
  configuration: "Runtime and project configuration.",
  "build-tooling": "Build, packaging, linting and compilation tooling.",
  documentation: "Documentation and examples.",
  observability: "Logging, metrics, tracing and health reporting.",
  "developer-tooling": "CLI and developer workflow utilities.",
  "retrieval-search": "Search, retrieval, ranking and context selection.",
  "indexing-analysis": "Indexing, parsing, extraction and static analysis.",
  unknown: "Evidence that cannot be classified reliably.",
};
