import { describe, expect, test } from "bun:test";
import { Daemon } from "../src/daemon.js";

// NOTE: do NOT use mock.module here — it is global across ALL test files in
// bun and would poison llm.test.ts. Instead mock globalThis.fetch to
// intercept only the external API calls that callLLM makes, while letting
// the test's own HTTP requests (to localhost:PORT) pass through.
const originalFetch = globalThis.fetch;

const START_WAIT = 300;

describe("POST /api/llm", () => {
  test("returns 500 when callLLM fails and includes error message", async () => {
    // Make the LLM call fail (e.g. non-2xx status from the API).
    globalThis.fetch = async (url, init) => {
      const urlStr = url.toString();
      if (!urlStr.includes("localhost") && !urlStr.includes("127.0.0.1")) {
        return new Response("API unavailable", { status: 503 });
      }
      return originalFetch(url, init);
    };

    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, START_WAIT));

    try {
      const resp = await fetch(
        `http://localhost:${d.getState().port}/api/llm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "test", model: "gpt-4o" }),
        },
      );
      expect(resp.status).toBe(500);
      const body = await resp.json();
      expect(body).toHaveProperty("error");
      expect(body.error).toContain("OpenAI API error (503)");
    } finally {
      d.stop();
      await startPromise;
      globalThis.fetch = originalFetch;
    }
  });

  test("returns 401 when auth key is configured but request lacks header", async () => {
    const previousKey = process.env.LOOP_API_KEY;
    process.env.LOOP_API_KEY = "test-secret";

    globalThis.fetch = async (url, init) => {
      const urlStr = url.toString();
      if (!urlStr.includes("localhost") && !urlStr.includes("127.0.0.1")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200 },
        );
      }
      return originalFetch(url, init);
    };

    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, START_WAIT));

    try {
      const resp = await fetch(
        `http://localhost:${d.getState().port}/api/llm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "test" }),
        },
      );
      expect(resp.status).toBe(401);
      const body = await resp.json();
      expect(body.error).toBe("unauthorized");
    } finally {
      d.stop();
      await startPromise;
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) {
        delete process.env.LOOP_API_KEY;
      } else {
        process.env.LOOP_API_KEY = previousKey;
      }
    }
  });

  test("returns 400 when prompt is empty", async () => {
    // Explicitly clear auth key for this test
    const previousKey = process.env.LOOP_API_KEY;
    delete process.env.LOOP_API_KEY;

    globalThis.fetch = async (url, init) => {
      const urlStr = url.toString();
      if (!urlStr.includes("localhost") && !urlStr.includes("127.0.0.1")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200 },
        );
      }
      return originalFetch(url, init);
    };

    const d = new Daemon(0);
    const startPromise = d.start();
    await new Promise((r) => setTimeout(r, START_WAIT));

    try {
      const resp = await fetch(
        `http://localhost:${d.getState().port}/api/llm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "" }),
        },
      );
      expect(resp.status).toBe(400);
      const body = await resp.json();
      expect(body.error).toBeDefined();
    } finally {
      d.stop();
      await startPromise;
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) {
        delete process.env.LOOP_API_KEY;
      } else {
        process.env.LOOP_API_KEY = previousKey;
      }
    }
  });
});
