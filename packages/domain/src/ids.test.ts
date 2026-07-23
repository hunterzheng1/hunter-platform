import { describe, expect, it } from "vitest";
import {
  AttemptIdSchema,
  ArtifactIdSchema,
  GateIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
} from "./index.js";

describe("canonical branded ids", () => {
  it("accepts canonical ids and rejects paths or arbitrary strings", () => {
    expect(ProjectIdSchema.parse("prj_00000001")).toBe("prj_00000001");
    expect(RunIdSchema.parse("run_00000001")).toBe("run_00000001");
    expect(AttemptIdSchema.parse("att_00000001")).toBe("att_00000001");
    expect(OperationIdSchema.parse("opn_00000001")).toBe("opn_00000001");
    expect(ArtifactIdSchema.parse("art_00000001")).toBe("art_00000001");
    expect(GateIdSchema.parse("gat_00000001")).toBe("gat_00000001");

    expect(() => ProjectIdSchema.parse("C:\\repo\\hunter")).toThrow();
    expect(() => RunIdSchema.parse("run")).toThrow();
    expect(() => ArtifactIdSchema.parse("C:\\private\\artifact")).toThrow();
    expect(() => GateIdSchema.parse("gate")).toThrow();
  });
});
