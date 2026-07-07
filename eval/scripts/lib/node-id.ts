import { isAbsolute, join } from "node:path";

/**
 * Gold node ids are stored repo-relative (`<relpath>#<symbol>`) so the gold is
 * portable across machines and re-clones. The graph (tensor.sqlite) stores
 * absolute paths from ts-morph `getFilePath()`, so relative gold ids must be
 * resolved against the repo path before they are compared to graph or
 * retrieval node ids.
 *
 * Legacy absolute gold ids are returned unchanged, so this is safe to apply to
 * both pre- and post-migration manifests.
 */
export function resolveNodeId(nodeId: string, repoPath: string): string {
  const hashIndex = nodeId.indexOf("#");
  const pathPart = hashIndex === -1 ? nodeId : nodeId.slice(0, hashIndex);
  const symbolPart = hashIndex === -1 ? "" : nodeId.slice(hashIndex);
  if (isAbsolute(pathPart)) return nodeId;
  return `${join(repoPath, pathPart)}${symbolPart}`;
}

/**
 * Inverse of {@link resolveNodeId}: strip the repo path prefix so an absolute
 * node id (e.g. from the graph or a retriever) becomes repo-relative. Ids that
 * do not live under `repoPath` are returned unchanged.
 */
export function toRelativeNodeId(nodeId: string, repoPath: string): string {
  const prefix = repoPath.endsWith("/") ? repoPath : `${repoPath}/`;
  return nodeId.startsWith(prefix) ? nodeId.slice(prefix.length) : nodeId;
}
