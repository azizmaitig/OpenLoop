import { runLoop } from "./src/loop-runner.ts";
import { parsePlanYaml } from "./src/plan-executor.ts";

const planPath = process.argv[2];
if (!planPath) { console.error("usage: bun run-notes.ts <plan.yaml>"); process.exit(2); }

const doc = await parsePlanYaml(planPath);
const config = {
  taskName: doc.planName,
  planName: doc.planName,
  maxIterations: 1,
  phaseTimeoutMs: 120000,
  planPath,
  phases: doc.tasks.map(t => ({
    name: t.id,
    command: t.command,
    expectedExitCode: 0,
    timeoutMs: t.timeoutMs ?? 30000,
    healCommand: t.healCommand,
    maxRetries: t.maxRetries,
    llm: t.llm,
  })),
};

const code = await runLoop(config);
process.exit(code);
