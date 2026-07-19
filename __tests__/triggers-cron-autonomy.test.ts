import { describe, expect, test, spyOn } from "bun:test";
import { CronTrigger } from "../src/triggers.js";

/**
 * Regression test for Bug 1: CronTrigger.start() must NOT unref() its interval
 * timer. unref() lets the process exit while the cron timer is the only
 * pending handle, which silently kills the daemon's scheduled triggers — the
 * daemon starts, registers the trigger, then exits and cron never fires.
 *
 * The test spies on setInterval and records whether the returned timer had
 * unref() called on it. Before the fix start() calls intervalId.unref(),
 * leaving unrefCalled === true (the bug). After the fix it stays false.
 */
describe("Bug 1 — cron timer must stay ref'd (no unref)", () => {
  test("CronTrigger.start() does not call unref() on its interval", () => {
    let unrefCalled = false;

    const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
      ((_cb: () => void, _ms?: number) => {
        const timer: any = {
          unref() {
            unrefCalled = true;
            return timer;
          },
          ref() {
            return timer;
          },
          clear: () => {},
        };
        return timer as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
    );

    try {
      const trigger = new CronTrigger("* * * * *", () => {});
      trigger.start(50_000);

      expect(unrefCalled).toBe(false);

      trigger.stop();
    } finally {
      intervalSpy.mockRestore();
    }
  });
});
