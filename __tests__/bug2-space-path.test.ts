import { describe, expect, test, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { executeTask, type TaskContext } from "../src/task-processor.js";
import { TaskQueue } from "../src/task-queue.js";

/**
 * Regression test for Bug 2: space-containing paths in enqueued commands
 * were fragmented by `task.command.split(/\s+/)` before being passed to
 * Bun.spawn for .ps1 tasks. A path like `C:\some dir with spaces\runner.ps1`
 * must reach the child process as a SINGLE argv token, not 5 fragments.
 */

let tmpRoot: string;

function setupCtx(): { ctx: TaskContext; queue: TaskQueue } {
  const queue = new TaskQueue();
  const ctx: TaskContext = {
    taskQueue: queue,
    baseDir: tmpRoot,
    getState: () => ({ status: "idle" }),
    isPaused: async () => false,
    broadcast: () => {},
    callLLM: async () => "ok",
    isSafeCommand: () => true,
    saveTaskHistory: async () => "hist-id",
    updateStateMd: async () => {},
  };
  return { ctx, queue };
}

describe("Bug 2 — space-containing path preserved in .ps1 spawn", () => {
  afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("a .ps1 path with spaces is passed to Bun.spawn as one argv token", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "bug2-space-"));

    // parent dir contains spaces — exercises the bug
    const scriptDir = join(tmpRoot, "some dir with spaces");
    const scriptPath = join(scriptDir, "runner.ps1");
    require("node:fs").mkdirSync(scriptDir, { recursive: true });

    const spacedArg = "value with spaces";

    // Spy on Bun.spawn to capture the argv array the .ps1 branch hands to it,
    // without spawning a real (slow/hanging) powershell process.
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(
      ((_args: unknown[]) =>
        ({
          stdout: new Blob([]).stream(),
          stderr: new Blob([]).stream(),
          exited: Promise.resolve(0),
        })) as unknown as typeof Bun.spawn,
    );

    const { ctx, queue } = setupCtx();
    // Real .ps1 branch: command starts with the script path (powershell.exe
    // -NoProfile -File are prepended by task-processor's isPs1 branch). The
    // path itself contains spaces and is wrapped in quotes by the enqueuer.
    const command = `"${scriptPath}" "${spacedArg}"`;
    const task = queue.enqueue(command);

    await executeTask(task, ctx);

    expect(spawnSpy).toHaveBeenCalled();
    const spawnedArgs = spawnSpy.mock.calls[0][0] as string[];

    // The script path must be a single argv token...
    expect(spawnArgsContain(spawnedArgs, scriptPath)).toBe(true);
    // ...and the quoted value-with-spaces must also stay one token.
    expect(spawnArgsContain(spawnedArgs, spacedArg)).toBe(true);
    // If fragmentation occurred, the path would be split into "some" "dir"
    // "with" "spaces\runner.ps1" — none of which equals the full path.
    expect(spawnArgsContain(spawnedArgs, "with")).toBe(false);

    spawnSpy.mockRestore();
  });
});

function spawnArgsContain(args: string[], needle: string): boolean {
  return args.some((a) => a === needle || a.replace(/^"|"$/g, "") === needle);
}
