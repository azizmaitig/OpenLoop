import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FIXTURE = "__tests__/fixtures/sample.plan.yaml";

describe("plan-driven loop integration", () => {
  let tmpDir: string;
  let tmpPlan: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agent-loop-plan-int-"));
    tmpPlan = join(tmpDir, "sample.plan.yaml");
    await copyFile(FIXTURE, tmpPlan);
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("--plan flag loads phases from yaml and exits 0", async () => {
    const proc = Bun.spawn(["bun", "run", "loop.ts", "start", "--plan", tmpPlan, "--max-iterations", "1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  test("writes status and completedAt fields back to plan yaml after run", async () => {
    // Use a fresh copy so the pre-run state is clean
    const cleanDir = await mkdtemp(join(tmpdir(), "agent-loop-plan-clean-"));
    const cleanPlan = join(cleanDir, "sample.plan.yaml");
    await copyFile(FIXTURE, cleanPlan);

    const proc = Bun.spawn(["bun", "run", "loop.ts", "start", "--plan", cleanPlan, "--max-iterations", "1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await proc.exited;

    const content = await Bun.file(cleanPlan).text();
    expect(content).toContain("status:");
    expect(content).toContain("completedAt:");

    await rm(cleanDir, { recursive: true, force: true });
  });

  test("missing plan file falls back to default task and exits 0", async () => {
    const proc = Bun.spawn(["bun", "run", "loop.ts", "start", "--plan", "__tests__/fixtures/nonexistent.yaml", "--max-iterations", "1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exitCode = await proc.exited;
    // Falls back to default demo task phases — still succeeds
    expect(exitCode).toBe(0);
  });
});
