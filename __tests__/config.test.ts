import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  agentServerFromEnv,
  mergeConfig,
  opencodeServerFromEnv,
} from "../src/config.js";
import type { LoopConfig } from "../src/types.js";

const AGENT_SERVER_ENV_KEYS = [
  "LOOP_AGENT_SERVER_MANAGE",
  "LOOP_AGENT_SERVER_URL",
  "LOOP_AGENT_SERVER_PORT",
  "LOOP_AGENT_SERVER_READY_TIMEOUT_MS",
  "LOOP_AGENT_SERVER_MAX_RESTARTS",
  "LOOP_AGENT_SERVER_DEFAULTS_PROVIDER",
  "LOOP_AGENT_SERVER_DEFAULTS_MODEL",
  "LOOP_AGENT_SERVER_DEFAULTS_BASE_URL",
  "LOOP_AGENT_SERVER_DEFAULTS_API_KEY",
];

function clearAgentServerEnv(): void {
  for (const key of AGENT_SERVER_ENV_KEYS) {
    delete process.env[key];
  }
}

describe("DEFAULT_CONFIG", () => {
  test("maxIterations is 3", () => {
    expect(DEFAULT_CONFIG.maxIterations).toBe(3);
  });

  test("phaseTimeoutMs is 60000", () => {
    expect(DEFAULT_CONFIG.phaseTimeoutMs).toBe(60000);
  });

  test("taskName is 'default-task'", () => {
    expect(DEFAULT_CONFIG.taskName).toBe("default-task");
  });

  test("phases is empty array", () => {
    expect(DEFAULT_CONFIG.phases).toEqual([]);
  });
});

describe("mergeConfig", () => {
  test("returns base config when override is empty", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {});
    expect(merged.maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
    expect(merged.phaseTimeoutMs).toBe(DEFAULT_CONFIG.phaseTimeoutMs);
    expect(merged.taskName).toBe(DEFAULT_CONFIG.taskName);
  });

  test("preserves values from override", () => {
    const override: Partial<LoopConfig> = {
      taskName: "custom-task",
      phaseTimeoutMs: 30000,
    };
    const merged = mergeConfig(DEFAULT_CONFIG, override);
    expect(merged.taskName).toBe("custom-task");
    expect(merged.phaseTimeoutMs).toBe(30000);
    expect(merged.maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
  });

  test("overrides maxIterations when below cap", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { maxIterations: 5 });
    expect(merged.maxIterations).toBe(5);
  });

  test("enforces hard cap of 20 for maxIterations", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { maxIterations: 50 });
    expect(merged.maxIterations).toBe(20);
  });

  test("enforces hard cap of 20 at the boundary", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { maxIterations: 20 });
    expect(merged.maxIterations).toBe(20);
  });

  test("enforces hard cap of 20 with negative value", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { maxIterations: -5 });
    expect(merged.maxIterations).toBe(-5);
  });

  test("merges phases from override", () => {
    const phases = [
      { name: "lint", command: "", expectedExitCode: 0, timeoutMs: 60000 },
    ];
    const merged = mergeConfig(DEFAULT_CONFIG, { phases });
    expect(merged.phases).toEqual(phases);
  });

  test("override does not mutate base config", () => {
    const origIterations = DEFAULT_CONFIG.maxIterations;
    mergeConfig(DEFAULT_CONFIG, { maxIterations: 10 });
    expect(DEFAULT_CONFIG.maxIterations).toBe(origIterations);
  });
});

describe("agentServer config (v10, ADR-0023)", () => {
  test("DEFAULT_CONFIG ships manage=true with url and port defaults", () => {
    expect(DEFAULT_CONFIG.agentServer).toEqual({
      manage: true,
      url: "http://127.0.0.1:8000",
      port: 8000,
    });
  });

  test("mergeConfig accepts a full agentServer override", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      agentServer: { manage: false, url: "http://localhost:18000", port: 18000 },
    });
    expect(merged.agentServer).toEqual({
      manage: false,
      url: "http://localhost:18000",
      port: 18000,
    });
  });

  test("mergeConfig deep-merges partial agentServer overrides over defaults", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { agentServer: { manage: false } });
    expect(merged.agentServer).toEqual({
      manage: false,
      url: "http://127.0.0.1:8000",
      port: 8000,
    });
  });

  test("mergeConfig merges agentServer.defaults over base defaults", () => {
    const base = {
      ...DEFAULT_CONFIG,
      agentServer: {
        ...DEFAULT_CONFIG.agentServer!,
        defaults: { provider: "openai", model: "gpt-4o" },
      },
    };
    const merged = mergeConfig(base, { agentServer: { defaults: { model: "qwen2.5-coder" } } });
    expect(merged.agentServer!.defaults).toEqual({
      provider: "openai",
      model: "qwen2.5-coder",
    });
  });

  test("mergeConfig does not mutate the base agentServer", () => {
    mergeConfig(DEFAULT_CONFIG, { agentServer: { manage: false } });
    expect(DEFAULT_CONFIG.agentServer).toEqual({
      manage: true,
      url: "http://127.0.0.1:8000",
      port: 8000,
    });
  });
});

describe("agentServerFromEnv", () => {
  test("returns empty overrides when no LOOP_AGENT_SERVER_* vars are set", () => {
    clearAgentServerEnv();
    expect(agentServerFromEnv()).toEqual({});
  });

  test("reads scalar overrides from LOOP_AGENT_SERVER_*", () => {
    clearAgentServerEnv();
    process.env.LOOP_AGENT_SERVER_MANAGE = "false";
    process.env.LOOP_AGENT_SERVER_URL = "http://127.0.0.1:4096";
    process.env.LOOP_AGENT_SERVER_PORT = "8001";
    process.env.LOOP_AGENT_SERVER_READY_TIMEOUT_MS = "60000";
    process.env.LOOP_AGENT_SERVER_MAX_RESTARTS = "5";
    try {
      expect(agentServerFromEnv()).toEqual({
        manage: false,
        url: "http://127.0.0.1:4096",
        port: 8001,
        readyTimeoutMs: 60000,
        maxRestarts: 5,
      });
    } finally {
      clearAgentServerEnv();
    }
  });

  test("reads LLM defaults from LOOP_AGENT_SERVER_DEFAULTS_*", () => {
    clearAgentServerEnv();
    process.env.LOOP_AGENT_SERVER_DEFAULTS_PROVIDER = "opencode";
    process.env.LOOP_AGENT_SERVER_DEFAULTS_MODEL = "deepseek-v4-flash-free";
    process.env.LOOP_AGENT_SERVER_DEFAULTS_BASE_URL = "http://127.0.0.1:4097";
    process.env.LOOP_AGENT_SERVER_DEFAULTS_API_KEY = "sk-none";
    try {
      expect(agentServerFromEnv()).toEqual({
        defaults: {
          provider: "opencode",
          model: "deepseek-v4-flash-free",
          baseUrl: "http://127.0.0.1:4097",
          apiKey: "sk-none",
        },
      });
    } finally {
      clearAgentServerEnv();
    }
  });
});

describe("opencodeServer config (v11, ADR-0024)", () => {
  test("DEFAULT_CONFIG ships opencodeServer with the default url + idle timeout", () => {
    expect(DEFAULT_CONFIG.opencodeServer).toEqual({
      url: "http://127.0.0.1:4096",
      idleTimeoutMs: 60000,
    });
  });

  test("mergeConfig accepts a full opencodeServer override", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      opencodeServer: { url: "http://127.0.0.1:4097" },
    });
    expect(merged.opencodeServer).toEqual({
      url: "http://127.0.0.1:4097",
      idleTimeoutMs: 60000,
    });
  });

  test("mergeConfig deep-merges partial opencodeServer overrides over defaults", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { opencodeServer: {} });
    expect(merged.opencodeServer).toEqual({
      url: "http://127.0.0.1:4096",
      idleTimeoutMs: 60000,
    });
  });

  test("mergeConfig does not mutate the base opencodeServer", () => {
    mergeConfig(DEFAULT_CONFIG, { opencodeServer: { url: "http://127.0.0.1:4097" } });
    expect(DEFAULT_CONFIG.opencodeServer).toEqual({
      url: "http://127.0.0.1:4096",
      idleTimeoutMs: 60000,
    });
  });

  test("mergeConfig honours an idleTimeoutMs override", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      opencodeServer: { url: "http://127.0.0.1:4096", idleTimeoutMs: 5000 },
    });
    expect(merged.opencodeServer?.idleTimeoutMs).toBe(5000);
  });
});

describe("opencodeServerFromEnv", () => {
  test("returns empty overrides when no LOOP_OPENCODE_SERVER_* vars are set", () => {
    delete process.env.LOOP_OPENCODE_SERVER_URL;
    delete process.env.LOOP_OPENCODE_SERVER_IDLE_TIMEOUT_MS;
    expect(opencodeServerFromEnv()).toEqual({});
  });

  test("reads the url from LOOP_OPENCODE_SERVER_URL", () => {
    delete process.env.LOOP_OPENCODE_SERVER_URL;
    delete process.env.LOOP_OPENCODE_SERVER_IDLE_TIMEOUT_MS;
    process.env.LOOP_OPENCODE_SERVER_URL = "http://127.0.0.1:4097";
    try {
      expect(opencodeServerFromEnv()).toEqual({ url: "http://127.0.0.1:4097" });
    } finally {
      delete process.env.LOOP_OPENCODE_SERVER_URL;
    }
  });

  test("reads idleTimeoutMs from LOOP_OPENCODE_SERVER_IDLE_TIMEOUT_MS", () => {
    delete process.env.LOOP_OPENCODE_SERVER_URL;
    delete process.env.LOOP_OPENCODE_SERVER_IDLE_TIMEOUT_MS;
    process.env.LOOP_OPENCODE_SERVER_IDLE_TIMEOUT_MS = "5000";
    try {
      expect(opencodeServerFromEnv()).toEqual({ idleTimeoutMs: 5000 });
    } finally {
      delete process.env.LOOP_OPENCODE_SERVER_IDLE_TIMEOUT_MS;
    }
  });

  test("ignores a non-numeric LOOP_OPENCODE_SERVER_IDLE_TIMEOUT_MS", () => {
    delete process.env.LOOP_OPENCODE_SERVER_URL;
    delete process.env.LOOP_OPENCODE_SERVER_IDLE_TIMEOUT_MS;
    process.env.LOOP_OPENCODE_SERVER_IDLE_TIMEOUT_MS = "soon";
    try {
      expect(opencodeServerFromEnv()).toEqual({});
    } finally {
      delete process.env.LOOP_OPENCODE_SERVER_IDLE_TIMEOUT_MS;
    }
  });
});
