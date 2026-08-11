# Learnings

## [LRN-20260812-001] correction

**Logged**: 2026-08-12T00:36:56.5236885+08:00
**Priority**: medium
**Status**: pending
**Area**: product-capability

### Summary

Do not present dormant backend routes and contracts as an available product capability.

### Details

The workflow-family schema, create route, and source-sync endpoint exist, but the current Workflows UI is read-only plus “check updates”. It has no create, source import, profile upload, or publish flow. Describing that plumbing as an existing Hunter-Harness workflow-import capability was incorrect.

### Suggested Action

When assessing a product capability, trace the complete path from UI entry through client call and server route to a compatible real artifact. Label incomplete layers as plumbing rather than a delivered capability.

### Metadata

- Source: user_feedback
- Related Files: apps/web/components/workflow-center.tsx, apps/server/src/app.ts, apps/server/src/registry/workflow-family-sync.ts
- Tags: correction, capability-verification, workflow-import
- Pattern-Key: capability.backend_plumbing_is_not_product
- Recurrence-Count: 1
- First-Seen: 2026-08-12
- Last-Seen: 2026-08-12

---

## [LRN-20260812-002] correction

**Logged**: 2026-08-12T00:52:10.0642376+08:00
**Priority**: medium
**Status**: pending
**Area**: config

### Summary

Confirm the intended repository pair before running multi-repository Git operations.

### Details

The active workspace and memory repository initially suggested the wrong second repository. The user clarified that the requested pair was `hunter-platform` and `Hunter-Harness`.

### Suggested Action

For requests referring to “two repositories”, enumerate likely Git roots and confirm the product repositories from the active task context before staging, committing, or pushing anything.

### Metadata

- Source: user_feedback
- Related Files: none
- Tags: correction, git, repository-scope
- Pattern-Key: git.confirm_multi_repo_scope
- Recurrence-Count: 1
- First-Seen: 2026-08-12
- Last-Seen: 2026-08-12

---
