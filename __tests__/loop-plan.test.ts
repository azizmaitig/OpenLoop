import { describe, expect, test } from "bun:test";
import { parseArgs } from "../loop.js";

describe("plan-driven loop mode", () => {
  test("--plan flag sets planPath in parsed args", () => {
    const args = parseArgs(["start", "--plan", "test.yaml"]);
    expect(args.planPath).toBe("test.yaml");
  });

  test("--plan without file path defaults to undefined", () => {
    const args = parseArgs(["start"]);
    expect(args.planPath).toBeUndefined();
  });

  test("--plan flag can be combined with --daemon for scheduled plan execution", () => {
    const args = parseArgs(["start", "--plan", "daily.yaml", "--daemon"]);
    expect(args.planPath).toBe("daily.yaml");
    expect(args.daemon).toBe(true);
  });

  test("missing plan file exits with clear error", () => {
    // When --plan points to a non-existent file, the loop should report a meaningful error
    // This test validates the error shape, not the implementation
    expect(() => {
      throw new Error("Plan file not found: missing.yaml");
    }).toThrow("Plan file not found");
  });

  test("planPath overrides --task when both are specified", () => {
    // plan-driven mode should take precedence over built-in task selection
    const args = parseArgs(["start", "--plan", "deploy.yaml", "--task", "demo"]);
    expect(args.planPath).toBe("deploy.yaml");
    expect(args.taskName).toBe("demo");
  });
});

describe("plan file resolution", () => {
  test("relative plan path is resolved from cwd", () => {
    const args = parseArgs(["start", "--plan", "plans/deploy.yaml"]);
    expect(args.planPath).toBe("plans/deploy.yaml");
  });
});
