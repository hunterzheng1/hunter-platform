// @vitest-environment jsdom

import type {
  ArtifactPageHttpResponse,
  RunStepHttpView,
} from "@hunter/api-contracts";
import {
  ArtifactIdSchema,
  AttemptIdSchema,
  ProjectIdSchema,
  StepRunIdSchema,
} from "@hunter/domain";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StepDetail } from "./step-detail.js";

const artifactId = ArtifactIdSchema.parse("art_stepdetail01");

afterEach(() => {
  cleanup();
});

const step: RunStepHttpView = {
  stepRunId: StepRunIdSchema.parse("spr_stepdetail01"),
  title: "实现",
  conclusion: "active",
  attempts: [{
    attemptId: AttemptIdSchema.parse("att_stepdetail01"),
    attemptNumber: 1,
    isCurrent: true,
    executionStatus: "running",
    verificationStatus: "pending",
    artifactIds: [artifactId],
    evidenceIds: [],
  }],
};

function page(input: {
  readonly cursor: number;
  readonly nextCursor: number;
  readonly highWaterCursor: number;
  readonly complete: boolean;
  readonly content: string;
}): ArtifactPageHttpResponse {
  return {
    schemaVersion: 1,
    status: "ok",
    artifact: {
      artifactId,
      projectId: ProjectIdSchema.parse("prj_stepdetail01"),
      attemptId: AttemptIdSchema.parse("att_stepdetail01"),
      kind: "log",
      retentionClass: "standard",
      summary: "bounded step log",
      byteLength: 11,
      entryCount: input.highWaterCursor,
    },
    cursor: input.cursor,
    nextCursor: input.nextCursor,
    retentionFloor: 0,
    highWaterCursor: input.highWaterCursor,
    complete: input.complete,
    responseBytes: Buffer.byteLength(input.content, "utf8"),
    entries: [{
      cursor: input.nextCursor,
      stream: "stdout",
      content: input.content,
      contentHash: "a".repeat(64),
      byteLength: Buffer.byteLength(input.content, "utf8"),
      occurredAt: "2026-07-24T12:00:00.000Z",
    }],
  };
}

describe("StepDetail Artifact pagination", () => {
  it("does not fetch automatically and replaces the current page instead of accumulating the full log", async () => {
    const loadArtifactPage = vi.fn()
      .mockResolvedValueOnce(page({
        cursor: 0,
        nextCursor: 1,
        highWaterCursor: 2,
        complete: false,
        content: "first-page",
      }))
      .mockResolvedValueOnce(page({
        cursor: 1,
        nextCursor: 2,
        highWaterCursor: 2,
        complete: true,
        content: "second-page",
      }));
    render(
      <StepDetail step={step} loadArtifactPage={loadArtifactPage} />,
    );

    expect(loadArtifactPage).not.toHaveBeenCalled();
    expect(screen.queryByText("first-page")).toBeNull();
    fireEvent.click(screen.getByRole("button", {
      name: `加载产物 ${artifactId}`,
    }));
    expect(await screen.findByText("first-page")).not.toBeNull();
    expect(loadArtifactPage).toHaveBeenCalledWith(artifactId, 0);

    fireEvent.click(screen.getByRole("button", { name: "加载下一页" }));
    expect(await screen.findByText("second-page")).not.toBeNull();
    await waitFor(() => {
      expect(screen.queryByText("first-page")).toBeNull();
    });
    expect(loadArtifactPage).toHaveBeenLastCalledWith(artifactId, 1);
    expect(screen.queryByRole("button", { name: "加载下一页" })).toBeNull();
  });

  it("shows an explicit retention gap and resumes from the reported floor", async () => {
    const resync: ArtifactPageHttpResponse = {
      schemaVersion: 1,
      status: "resync_required",
      artifactId,
      code: "ARTIFACT_CURSOR_RESYNC_REQUIRED",
      retentionFloor: 4,
      highWaterCursor: 5,
      instructions: {
        snapshot: "reload_artifact_summary",
        resume: "read_after_retention_floor",
      },
    };
    const loadArtifactPage = vi.fn()
      .mockResolvedValueOnce(resync)
      .mockResolvedValueOnce(page({
        cursor: 4,
        nextCursor: 5,
        highWaterCursor: 5,
        complete: true,
        content: "retained-page",
      }));
    render(
      <StepDetail step={step} loadArtifactPage={loadArtifactPage} />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: `加载产物 ${artifactId}`,
    }));
    expect((await screen.findByRole("alert")).textContent)
      .toContain("较早日志已按保留策略清理");
    fireEvent.click(screen.getByRole("button", {
      name: "从保留点重新同步",
    }));
    expect(await screen.findByText("retained-page")).not.toBeNull();
    expect(loadArtifactPage).toHaveBeenLastCalledWith(artifactId, 4);
  });

  it("keeps Artifact identifiers read-only when no page loader is available", () => {
    render(<StepDetail step={step} />);
    expect(screen.getByText(artifactId)).not.toBeNull();
    expect(screen.queryByRole("button", {
      name: `加载产物 ${artifactId}`,
    })).toBeNull();
  });
});
