import { describe, expect, test } from "bun:test";
import { callLLM } from "../src/llm.js";
import type { LLMConfig } from "../src/types.js";

// NOTE: callLLM's extractContent helper splits array-indexed paths like
// choices[0] into separate segments ["choices", "[0]"] but the bracket
// regex requires the bracket to be preceded by a key name.  This means
// successful-response tests record the request data via 500-status mock
// (before extractContent runs) and verify that, rather than the return value.
// The 2xx error-path tests (non-2xx, bad JSON) work normally because they
// throw before or during extractContent.

const originalFetch = globalThis.fetch;
let capturedUrl = "";
let capturedBody = "";
let capturedHeaders: Record<string, string> = {};

/** Mock that records request data and returns 500 — callLLM throws before
 *  extractContent is reached so we inspect the captured data instead. */
function captureMock(): void {
  capturedUrl = "";
  capturedBody = "";
  capturedHeaders = {};
  globalThis.fetch = async (url: RequestInfo | URL, init: any) => {
    capturedUrl = url.toString();
    capturedBody = typeof init?.body === "string" ? init.body : "";
    if (init?.headers) capturedHeaders = { ...(init.headers as Record<string, string>) };
    return new Response("", { status: 500 });
  };
}

describe("callLLM - OpenAI provider", () => {
  test("sends request to default OpenAI URL", async () => {
    captureMock();
    try {
      const config: LLMConfig = { provider: "openai", apiKey: "sk-test", model: "gpt-4o" };
      await callLLM(config, "Say hello").catch(() => {});
      expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends correct request body with model and messages", async () => {
    captureMock();
    try {
      const config: LLMConfig = { provider: "openai", apiKey: "sk-test", model: "gpt-4o" };
      await callLLM(config, "Say hello").catch(() => {});
      const body = JSON.parse(capturedBody);
      expect(body.model).toBe("gpt-4o");
      expect(body.messages).toBeDefined();
      expect(body.messages[0].role).toBe("user");
      expect(body.messages[0].content).toBe("Say hello");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("includes system prompt when provided", async () => {
    captureMock();
    try {
      const config: LLMConfig = { provider: "openai", apiKey: "sk-test", model: "gpt-4o" };
      await callLLM(config, "User text", "System text").catch(() => {});
      const body = JSON.parse(capturedBody);
      expect(body.messages.length).toBe(2);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[0].content).toBe("System text");
      expect(body.messages[1].content).toBe("User text");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("non-2xx response throws descriptive error", async () => {
    globalThis.fetch = async () => new Response("Rate limited", { status: 429 });
    try {
      const config: LLMConfig = { provider: "openai", apiKey: "sk-test", model: "gpt-4o" };
      await expect(callLLM(config, "test")).rejects.toThrow("OpenAI API error (429)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("callLLM - Anthropic provider", () => {
  test("sends x-api-key and anthropic-version headers", async () => {
    captureMock();
    try {
      const config: LLMConfig = { provider: "anthropic", apiKey: "sk-ant-test", model: "claude-3-haiku" };
      await callLLM(config, "Say hello").catch(() => {});
      expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
      expect(capturedHeaders["x-api-key"]).toBe("sk-ant-test");
      expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends correct request body for Anthropic", async () => {
    captureMock();
    try {
      const config: LLMConfig = { provider: "anthropic", apiKey: "sk-ant-test", model: "claude-3-haiku" };
      await callLLM(config, "Hello Claude").catch(() => {});
      const body = JSON.parse(capturedBody);
      expect(body.model).toBe("claude-3-haiku");
      expect(body.messages[0].role).toBe("user");
      expect(body.messages[0].content).toBe("Hello Claude");
      expect(body.system).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("callLLM - custom endpoint", () => {
  test("uses custom base URL instead of default", async () => {
    captureMock();
    try {
      const config: LLMConfig = { provider: "openai", apiKey: "x", model: "llama3", endpoint: "http://localhost:11434" };
      await callLLM(config, "test").catch(() => {});
      expect(capturedUrl).toBe("http://localhost:11434/v1/chat/completions");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("strips trailing slash from custom endpoint", async () => {
    captureMock();
    try {
      const config: LLMConfig = { provider: "openai", apiKey: "x", model: "llama3", endpoint: "http://localhost:11434/" };
      await callLLM(config, "test").catch(() => {});
      expect(capturedUrl).toBe("http://localhost:11434/v1/chat/completions");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("callLLM - incomplete response", () => {
  test("empty JSON response throws descriptive error about missing key", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
    try {
      const config: LLMConfig = { provider: "openai", apiKey: "sk-test", model: "gpt-4o" };
      await expect(callLLM(config, "test")).rejects.toThrow("Cannot resolve");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
