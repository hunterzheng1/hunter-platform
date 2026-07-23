import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";

import {
  AttemptIdSchema,
  CapabilityProbeReceiptIdSchema,
  ConnectorIdSchema,
  ControllerLeaseIdSchema,
  EvidenceIdSchema,
  LeaseOwnerIdSchema,
  NativeSessionIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RunIdSchema,
  RuntimeProviderIdSchema,
  WorkspaceIdSchema,
} from "@hunter/domain";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  BoundedProviderWorkspaceSchema,
  CanonicalWorkspaceKeySchema,
  ExternalBoundaryError,
  WorkspaceRefSchema,
  createWorkspacePathBoundary,
  decodeCapabilityProbeReceipt,
  decodeExternalId,
  decodeExternalOperationReceipt,
  parseBoundedProviderObject,
  type VerifiedWorkspacePath,
} from "./external-boundary.js";
import { createExternalOperation } from "./operations.js";

describe("shared external trust boundary", () => {
  let fixtureRoot: string | undefined;

  afterEach(() => {
    if (fixtureRoot !== undefined) {
      rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
  });

  it.each([
    ["invalid prefix", "run_boundary0001"],
    ["too long", `prj_${"a".repeat(97)}`],
    ["dot segment", "prj_boundary..01"],
    ["slash", "prj_boundary/001"],
    ["backslash", "prj_boundary\\001"],
    ["NUL", "prj_boundary\u0000001"],
  ])("BND-01 rejects %s as UNBRANDED_ID", (_label, candidate) => {
    expect(() => decodeExternalId(ProjectIdSchema, candidate)).toThrow(
      expect.objectContaining<Partial<ExternalBoundaryError>>({
        code: "UNBRANDED_ID",
      }),
    );
  });

  it("BND-02 decodes strict, bounded provider JSON without trusting workspaceRef as a path", () => {
    const valid = {
      workspaceRef: "provider-private:workspace-001",
      reportedWorkspacePath: resolve("registered", "workspace"),
    };
    expect(
      parseBoundedProviderObject(BoundedProviderWorkspaceSchema, valid),
    ).toEqual(valid);
    expect(() =>
      parseBoundedProviderObject(BoundedProviderWorkspaceSchema, {
        ...valid,
        token: "must-not-be-read",
      }),
    ).toThrow("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
    expect(() =>
      parseBoundedProviderObject(BoundedProviderWorkspaceSchema, {
        ...valid,
        workspaceRef: "x".repeat(70 * 1024),
      }),
    ).toThrow("PROVIDER_OUTPUT_TOO_LARGE");

    const opaque = WorkspaceRefSchema.parse(valid.workspaceRef);
    const consumeVerified = (path: VerifiedWorkspacePath): void => {
      void path;
    };
    // @ts-expect-error workspaceRef is deliberately not a filesystem path brand.
    consumeVerified(opaque);
    expect(() =>
      parseBoundedProviderObject(BoundedProviderWorkspaceSchema, {
        ...valid,
        reportedWorkspacePath: ".",
      }),
    ).toThrow("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
  });

  it("BND-02 bounds complete external receipts and capability probes", () => {
    const receipt = {
      schemaVersion: 1,
      operationId: OperationIdSchema.parse("opn_boundaryreceipt"),
      fingerprint: "a".repeat(64),
      operationStatus: "completed",
      subject: {
        kind: "provider",
        providerId: RuntimeProviderIdSchema.parse("rtp_boundaryreceipt"),
        implementationVersion: "1.0.0",
      },
      nativeReferences: [],
      facts: [{ kind: "operation_accepted" }],
      evidence: {
        evidenceId: EvidenceIdSchema.parse("evd_boundaryreceipt"),
        evidenceHash: "b".repeat(64),
        proofScope: "local_observation",
      },
      observedAt: "2026-07-23T00:00:00.000Z",
    };
    expect(decodeExternalOperationReceipt(receipt)).toEqual(receipt);
    expect(() =>
      decodeExternalOperationReceipt({
        ...receipt,
        subject: {
          ...receipt.subject,
          implementationVersion: "x".repeat(257),
        },
      }),
    ).toThrow("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
    expect(() =>
      decodeExternalOperationReceipt({
        ...receipt,
        facts: Array.from({ length: 33 }, () => ({ kind: "operation_accepted" })),
      }),
    ).toThrow("PROVIDER_OUTPUT_SCHEMA_MISMATCH");

    const probe = {
      schemaVersion: 1,
      probeReceiptId: CapabilityProbeReceiptIdSchema.parse("cpr_boundaryreceipt"),
      subject: {
        kind: "connector",
        connectorId: ConnectorIdSchema.parse("con_boundaryreceipt"),
        implementationVersion: "1.0.0",
      },
      platform: "windows",
      observedAt: "2026-07-23T00:00:00.000Z",
      validUntil: "2026-07-24T00:00:00.000Z",
      results: [{
        capability: "observe",
        status: "SUPPORTED",
        evidenceId: EvidenceIdSchema.parse("evd_boundaryprobe"),
        evidenceHash: "c".repeat(64),
      }],
    };
    expect(decodeCapabilityProbeReceipt(probe)).toEqual(probe);
    expect(() =>
      decodeCapabilityProbeReceipt({
        ...probe,
        subject: {
          ...probe.subject,
          implementationVersion: "x".repeat(257),
        },
      }),
    ).toThrow("PROVIDER_OUTPUT_SCHEMA_MISMATCH");
  });

  it("BND-02 rejects wide, cyclic, and non-JSON provider values with fixed boundary errors", () => {
    const wide = Array.from({ length: 200_000 }, () => null);
    expect(() =>
      parseBoundedProviderObject(z.array(z.null()), wide, 2 * 1024 * 1024),
    ).toThrow(
      expect.objectContaining<Partial<ExternalBoundaryError>>({
        code: "PROVIDER_OUTPUT_TOO_LARGE",
      }),
    );

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => parseBoundedProviderObject(z.unknown(), cyclic)).toThrow(
      expect.objectContaining<Partial<ExternalBoundaryError>>({
        code: "PROVIDER_OUTPUT_SCHEMA_MISMATCH",
      }),
    );
    expect(() =>
      parseBoundedProviderObject(z.unknown(), new Date("2026-07-23T00:00:00Z")),
    ).toThrow(
      expect.objectContaining<Partial<ExternalBoundaryError>>({
        code: "PROVIDER_OUTPUT_SCHEMA_MISMATCH",
      }),
    );

    let getterReads = 0;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "must-not-be-read";
      },
    });
    expect(() => parseBoundedProviderObject(z.unknown(), accessor)).toThrow(
      expect.objectContaining<Partial<ExternalBoundaryError>>({
        code: "PROVIDER_OUTPUT_SCHEMA_MISMATCH",
      }),
    );
    expect(getterReads).toBe(0);

    let toJsonCalls = 0;
    const withToJson = {
      value: "provider-data",
      toJSON: () => {
        toJsonCalls += 1;
        return { value: "rewritten" };
      },
    };
    expect(() => parseBoundedProviderObject(z.unknown(), withToJson)).toThrow(
      expect.objectContaining<Partial<ExternalBoundaryError>>({
        code: "PROVIDER_OUTPUT_SCHEMA_MISMATCH",
      }),
    );
    expect(toJsonCalls).toBe(0);
  });

  it("BND-03 resolves native paths and rejects a symlink or junction escape", () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "hunter-boundary-"));
    const registeredRoot = join(fixtureRoot, "repository");
    const outside = join(fixtureRoot, "outside");
    const workspace = join(registeredRoot, "workspace");
    mkdirSync(registeredRoot);
    mkdirSync(outside);
    mkdirSync(workspace);
    writeFileSync(join(outside, "private.txt"), "not a credential");
    const escape = join(registeredRoot, "escape");
    symlinkSync(outside, escape, process.platform === "win32" ? "junction" : "dir");

    const repositoryId = RepositoryIdSchema.parse("rep_boundary001");
    const boundary = createWorkspacePathBoundary(
      new Map([[repositoryId, registeredRoot]]),
    );
    expect(boundary.verify(repositoryId, workspace)).toBe(workspace);
    expect(() => boundary.verify(repositoryId, escape)).toThrow(
      expect.objectContaining<Partial<ExternalBoundaryError>>({
        code: "PATH_SCOPE_VIOLATION",
      }),
    );
  });

  it("BND-03 rejects same-name and lexical-prefix siblings outside the registered root", () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "hunter-boundary-siblings-"));
    const registeredRoot = join(fixtureRoot, "repository");
    const prefixSibling = join(fixtureRoot, "repository-copy");
    const sameNameSibling = join(fixtureRoot, "other", "repository");
    mkdirSync(registeredRoot);
    mkdirSync(prefixSibling);
    mkdirSync(sameNameSibling, { recursive: true });

    const repositoryId = RepositoryIdSchema.parse("rep_boundary003");
    const boundary = createWorkspacePathBoundary(
      new Map([[repositoryId, registeredRoot]]),
    );
    for (const outside of [prefixSibling, sameNameSibling]) {
      expect(() => boundary.verify(repositoryId, outside)).toThrow(
        expect.objectContaining<Partial<ExternalBoundaryError>>({
          code: "PATH_SCOPE_VIOLATION",
        }),
      );
    }
  });

  it("BND-03 permits spaces but rejects empty or controlled canonical workspace suffixes", () => {
    expect(
      CanonicalWorkspaceKeySchema.parse(
        "win32:c:\\program files\\hunter workspace",
      ),
    ).toBe("win32:c:\\program files\\hunter workspace");
    for (const candidate of [
      "win32:",
      "win32:c:\\safe\u0000escape",
      "posix:/safe/\u001fescape",
      "posix:/safe/\u007fescape",
    ]) {
      expect(CanonicalWorkspaceKeySchema.safeParse(candidate).success).toBe(
        false,
      );
    }
  });

  it.each([
    ["drive/case alias", "C:\\repo", "c:\\outside\\workspace"],
    ["mismatched UNC share", "\\\\server\\share\\repo", "\\\\server\\other\\workspace"],
    [
      "extended-length alias",
      "\\\\?\\C:\\repo",
      "\\\\?\\C:\\outside\\workspace",
    ],
  ])(
    "BND-04 rejects a %s after native resolution with segment containment",
    (_label, registeredRoot, resolvedWorkspace) => {
      const repositoryId = RepositoryIdSchema.parse("rep_boundary002");
      const canonicalRoot = win32.normalize(registeredRoot);
      const boundary = createWorkspacePathBoundary(
        new Map([[repositoryId, registeredRoot]]),
        {
          platform: "win32",
          realpathNative: (candidate) =>
            win32.normalize(candidate) === canonicalRoot
              ? registeredRoot
              : resolvedWorkspace,
        },
      );

      expect(() =>
        boundary.verify(repositoryId, `${registeredRoot}\\issued-workspace`),
      ).toThrow(
        expect.objectContaining<Partial<ExternalBoundaryError>>({
          code: "PATH_SCOPE_VIOLATION",
        }),
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "BND-04 verifies real Windows drive-case and extended-length paths without lexical trust",
    () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), "hunter-boundary-win32-"));
      const registeredRoot = join(fixtureRoot, "Repository");
      const workspace = join(registeredRoot, "Workspace");
      const outside = join(fixtureRoot, "Outside");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside);
      const repositoryId = RepositoryIdSchema.parse("rep_boundarywin1");
      const boundary = createWorkspacePathBoundary(
        new Map([[repositoryId, registeredRoot.toLowerCase()]]),
      );

      expect(boundary.verify(repositoryId, workspace.toUpperCase())).toBeTruthy();
      expect(() =>
        boundary.verify(repositoryId, outside.toLowerCase()),
      ).toThrow("PATH_SCOPE_VIOLATION");
      expect(() =>
        boundary.verify(repositoryId, `\\\\?\\${outside}`),
      ).toThrow("PATH_SCOPE_VIOLATION");
    },
  );

  it.runIf(process.platform === "win32")(
    "BND-04 rejects a real long-path junction escape on Windows",
    (context) => {
      fixtureRoot = mkdtempSync(join(tmpdir(), "hunter-boundary-long-"));
      const registeredRoot = join(fixtureRoot, "repository");
      const outside = join(
        fixtureRoot,
        "outside",
        ..."long-segment-0123456789abcdef".repeat(10).match(/.{1,28}/gu)!,
      );
      const escape = join(registeredRoot, "long-escape");
      try {
        mkdirSync(registeredRoot);
        mkdirSync(outside, { recursive: true });
        symlinkSync(outside, escape, "junction");
      } catch {
        context.skip("NOT_PROVEN: host Windows long-path support unavailable");
        return;
      }
      expect(outside.length).toBeGreaterThan(260);
      const repositoryId = RepositoryIdSchema.parse("rep_boundarywin2");
      const boundary = createWorkspacePathBoundary(
        new Map([[repositoryId, registeredRoot]]),
      );
      expect(() => boundary.verify(repositoryId, escape)).toThrow(
        "PATH_SCOPE_VIOLATION",
      );
    },
  );

  it(
    "BND-04 rejects a real mismatched localhost UNC share",
    (context) => {
      if (process.platform !== "win32") {
        context.skip("NOT_PROVEN: real Windows administrative shares require a Windows host");
        return;
      }
      const repositoryId = RepositoryIdSchema.parse("rep_boundaryunc1");
      const registeredShare = "\\\\localhost\\C$\\tmp";
      const mismatchedShare = "\\\\localhost\\ADMIN$";
      try {
        realpathSync.native(registeredShare);
        realpathSync.native(mismatchedShare);
      } catch {
        context.skip(
          "NOT_PROVEN: localhost C$/ADMIN$ shares are disabled or inaccessible",
        );
        return;
      }
      const boundary = createWorkspacePathBoundary(
        new Map([[repositoryId, registeredShare]]),
      );

      expect(boundary.verify(repositoryId, registeredShare)).toBeTruthy();
      expect(() => boundary.verify(repositoryId, mismatchedShare)).toThrow(
        "PATH_SCOPE_VIOLATION",
      );
    },
  );

  it("BND-05 allows only a decoded OperationId to cross the external boundary", () => {
    expect(
      decodeExternalId(OperationIdSchema, "opn_boundary0001"),
    ).toBe("opn_boundary0001");
    expect(() =>
      decodeExternalId(OperationIdSchema, "../private"),
    ).toThrow(
      expect.objectContaining<Partial<ExternalBoundaryError>>({
        code: "UNBRANDED_ID",
      }),
    );
  });

  it("accepts a canonical branded ID at the 96-character boundary", () => {
    const candidate = `prj_${"a".repeat(92)}`;
    expect(candidate).toHaveLength(96);
    expect(decodeExternalId(ProjectIdSchema, candidate)).toBe(candidate);
  });

  it.each([
    {
      operationId: "opn_taskpack14001",
      operationType: "task_pack.write",
      requestedCapabilities: ["artifact_export"],
      payload: {
        workspaceId: WorkspaceIdSchema.parse("wsp_boundary1401"),
        inputEvidenceId: EvidenceIdSchema.parse("evd_boundary1401"),
      },
    },
    {
      operationId: "opn_resume140001",
      operationType: "session.resume",
      requestedCapabilities: ["resume"],
      payload: {
        nativeSessionId: NativeSessionIdSchema.parse("ses_boundary1401"),
        controllerLeaseId: ControllerLeaseIdSchema.parse("ctl_boundary1401"),
        controllerLeaseOwnerId: LeaseOwnerIdSchema.parse("own_boundary1401"),
        controllerLeaseGeneration: 1,
      },
    },
  ])(
    "routes $operationType through a strict journalable ExternalOperation",
    (variant) => {
      const input = {
        schemaVersion: 1,
        operationId: OperationIdSchema.parse(variant.operationId),
        projectId: ProjectIdSchema.parse("prj_boundary1401"),
        runId: RunIdSchema.parse("run_boundary1401"),
        attemptId: AttemptIdSchema.parse("att_boundary1401"),
        operationVersion: 2,
        operationType: variant.operationType,
        requestedCapabilities: variant.requestedCapabilities,
        payload: variant.payload,
      };
      expect(createExternalOperation(input).operationType).toBe(
        variant.operationType,
      );
      expect(() =>
        createExternalOperation({
          ...input,
          payload: { ...variant.payload, workspacePath: "C:/private" },
        }),
      ).toThrow();
    },
  );
});
