import { describe, expect, test } from "bun:test";

describe("daemon mode", () => {
  test("daemon-runner.ts exports runDaemon function (verification via source)", () => {
    // runDaemon was extracted from loop.ts to src/daemon-runner.ts
    const fs = require("node:fs");
    const source = fs.readFileSync("./src/daemon-runner.ts", "utf-8");
    expect(source).toContain("async function runDaemon");
  });

  test("cli.ts contains --daemon flag handling", () => {
    // --daemon flag parsing was extracted from loop.ts to src/cli.ts
    const fs = require("node:fs");
    const source = fs.readFileSync("./src/cli.ts", "utf-8");
    expect(source).toContain("--daemon");
    expect(source).toContain("case '--daemon'");
  });

  test("loop.ts calls runDaemon from main()", () => {
    const fs = require("node:fs");
    const source = fs.readFileSync("./loop.ts", "utf-8");
    expect(source).toContain("runDaemon(config)");
  });
});
