import * as yaml from 'js-yaml';

/**
 * Load and parse a YAML file from disk.
 * Returns null if the file doesn't exist or parsing fails.
 */
export async function loadYaml<T = unknown>(path: string): Promise<T | null> {
  try {
    const file = Bun.file(path);
    const exists = await file.exists();
    if (!exists) return null;
    const text = await file.text();
    return yaml.load(text) as T;
  } catch {
    return null;
  }
}

/**
 * Parse a YAML string, returning null on failure.
 */
export function parseYaml<T = unknown>(str: string): T | null {
  try {
    return yaml.load(str) as T;
  } catch {
    return null;
  }
}

/**
 * Serialize a value to a YAML string.
 */
export function dumpYaml(data: unknown): string {
  return yaml.dump(data, { indent: 2, noRefs: true, lineWidth: 120 });
}

/**
 * Parse YAML frontmatter from markdown content.
 * Extracts the block between first --- and next --- or ...
 * Returns null if no valid frontmatter is found.
 */
export function parseFrontmatter<T = Record<string, unknown>>(content: string): T | null {
  const match = content.match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)/);
  if (!match) return null;
  try {
    return yaml.load(match[1]) as T;
  } catch {
    return null;
  }
}

/**
 * Serialize data to YAML frontmatter wrapped in --- markers.
 */
export function dumpFrontmatter(fm: Record<string, unknown>): string {
  const body = yaml.dump(fm, { indent: 2, lineWidth: 120, quotingType: '"', forceQuotes: false }).trimEnd();
  return `---\n${body}\n---`;
}
