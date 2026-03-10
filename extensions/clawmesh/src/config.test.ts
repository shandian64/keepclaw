import { describe, expect, it } from "vitest";
import { resolveClawMeshConfig } from "./config.js";

describe("ClawMesh config", () => {
  it("fails closed when allowedEvents is explicitly empty", () => {
    const config = resolveClawMeshConfig({
      github: {
        allowedEvents: [],
      },
    });

    expect(config.github.allowedEvents).toEqual([]);
  });

  it("drops invalid allowedEvents entries instead of widening to the full set", () => {
    const config = resolveClawMeshConfig({
      github: {
        allowedEvents: ["not-real", "issue_comment"],
      },
    });

    expect(config.github.allowedEvents).toEqual(["issue_comment"]);
  });
});
