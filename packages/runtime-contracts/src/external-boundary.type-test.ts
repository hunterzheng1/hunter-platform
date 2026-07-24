import type {
  VerifiedWorkspacePath,
  WorkspacePathBoundary,
  WorkspaceRef,
} from "./external-boundary.js";

declare const opaqueWorkspaceRef: WorkspaceRef;
declare const verifiedWorkspacePath: VerifiedWorkspacePath;
declare const boundary: WorkspacePathBoundary;

const consumeVerifiedPath = (path: VerifiedWorkspacePath): void => {
  void path;
};

consumeVerifiedPath(verifiedWorkspacePath);
boundary.canonicalKey(verifiedWorkspacePath);

// @ts-expect-error An opaque provider workspace reference is never a verified path.
consumeVerifiedPath(opaqueWorkspaceRef);
// @ts-expect-error Canonical path APIs accept only values issued by the path boundary.
boundary.canonicalKey(opaqueWorkspaceRef);

export {};
