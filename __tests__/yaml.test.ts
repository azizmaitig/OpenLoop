import { describe, expect, test } from "bun:test";
import { parseYaml, dumpYaml, parseFrontmatter, dumpFrontmatter } from "../src/yaml.js";

describe("parseYaml", () => {
  test("parses valid YAML", () => {
    const result = parseYaml("foo: bar\nbaz: 42");
    expect(result).toEqual({ foo: "bar", baz: 42 });
  });

  test("returns null for invalid YAML", () => {
    expect(parseYaml("{{ broken }")).toBeNull();
    expect(parseYaml("[unclosed")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseYaml("")).toBeNull();
  });

  test("preserves typed values", () => {
    const result = parseYaml("count: 3\nactive: true\nname: test");
    expect(result).toEqual({ count: 3, active: true, name: "test" });
  });
});

describe("dumpYaml", () => {
  test("serializes an object", () => {
    const result = dumpYaml({ foo: "bar", num: 42 });
    expect(result).toContain("foo: bar");
    expect(result).toContain("num: 42");
  });

  test("dumpYaml result can be re-parsed", () => {
    const dumped = dumpYaml({ hello: "world", arr: [1, 2, 3] });
    const parsed = parseYaml(dumped);
    expect(parsed).toEqual({ hello: "world", arr: [1, 2, 3] });
  });
});

describe("parseFrontmatter", () => {
  test("parses YAML frontmatter from markdown", () => {
    const md = `---\npaused: true\ncount: 3\n---\n\nBody text here`;
    const result = parseFrontmatter(md);
    expect(result).toEqual({ paused: true, count: 3 });
  });

  test("returns null for content without frontmatter", () => {
    expect(parseFrontmatter("no frontmatter")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseFrontmatter("")).toBeNull();
  });

  test("handles ... delimiter", () => {
    const md = `---\npaused: false\n...\nBody text`;
    const result = parseFrontmatter(md);
    expect(result).toEqual({ paused: false });
  });
});

describe("dumpFrontmatter", () => {
  test("wraps in --- markers", () => {
    const result = dumpFrontmatter({ paused: false });
    expect(result.startsWith("---\n")).toBe(true);
    expect(result.endsWith("\n---")).toBe(true);
    expect(result).toContain("paused: false");
  });

  test("dumpFrontmatter result can be re-parsed by parseFrontmatter", () => {
    const fm = { paused: true, version: 1, name: "test" };
    const dumped = dumpFrontmatter(fm);
    const reparsed = parseFrontmatter(dumped);
    expect(reparsed).toEqual(fm);
  });
});
