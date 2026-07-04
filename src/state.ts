import type { LoopState, LoopConfig, PhaseResult } from './types.js';

const STATE_VERSION = 1;

function serializeYamlFrontmatter(state: LoopState): string {
  const phaseResultsJson = JSON.stringify(state.phaseResults);
  const errorsJson = JSON.stringify(state.errors);

  const lines: string[] = [
    '---',
    `version: ${STATE_VERSION}`,
    `currentState: ${state.currentState}`,
    `iteration: ${state.iteration}`,
    `startTime: "${state.startTime}"`,
    `phaseResults: ${phaseResultsJson}`,
    `errors: ${errorsJson}`,
    '---',
  ];
  return lines.join('\n');
}

function parseYamlFrontmatter(content: string): LoopState | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const lines = yaml.split('\n');
  const parsed: Record<string, unknown> = {};

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const valueStr = line.slice(colonIdx + 1).trim();
    if (!key) continue;

    // Complex objects — JSON parse
    if (valueStr === '{}' || valueStr === '[]' || valueStr.startsWith('{') || valueStr.startsWith('[')) {
      try {
        parsed[key] = JSON.parse(valueStr);
      } catch {
        parsed[key] = valueStr;
      }
      continue;
    }

    // Quoted string
    if ((valueStr.startsWith('"') && valueStr.endsWith('"')) ||
        (valueStr.startsWith("'") && valueStr.endsWith("'"))) {
      parsed[key] = valueStr.slice(1, -1);
      continue;
    }

    // Number
    if (/^-?\d+(\.\d+)?$/.test(valueStr)) {
      parsed[key] = Number(valueStr);
      continue;
    }

    // Boolean
    if (valueStr === 'true') { parsed[key] = true; continue; }
    if (valueStr === 'false') { parsed[key] = false; continue; }

    // Plain string fallback
    parsed[key] = valueStr;
  }

  const currentState = parsed.currentState as LoopState['currentState'];
  const iteration = parsed.iteration as number;
  const phaseResults = parsed.phaseResults as Record<string, PhaseResult>;
  const startTime = parsed.startTime as string;
  const errors = parsed.errors as string[];

  if (!currentState || typeof iteration !== 'number') {
    return null;
  }

  return {
    currentState,
    iteration,
    phaseResults: phaseResults ?? {},
    startTime: startTime ?? '',
    errors: errors ?? [],
  };
}

export async function readState(path: string): Promise<LoopState | null> {
  let content: string;
  try {
    const file = Bun.file(path);
    const exists = await file.exists();
    if (!exists) return null;
    content = await file.text();
  } catch {
    return null;
  }

  // Try YAML frontmatter first (.md files)
  const fromYaml = parseYamlFrontmatter(content);
  if (fromYaml) return fromYaml;

  // Fallback: plain JSON
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.currentState === 'string' && typeof parsed.iteration === 'number') {
      return {
        currentState: parsed.currentState,
        iteration: parsed.iteration,
        phaseResults: parsed.phaseResults ?? {},
        startTime: parsed.startTime ?? '',
        errors: parsed.errors ?? [],
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeState(path: string, state: LoopState): Promise<void> {
  const content = serializeYamlFrontmatter(state);
  await Bun.write(path, content);
}

export function createInitialState(config: LoopConfig): LoopState {
  return {
    currentState: 'init',
    iteration: 0,
    phaseResults: {},
    startTime: new Date().toISOString(),
    errors: [],
  };
}

export function updatePhaseResult(
  state: LoopState,
  phaseName: string,
  result: PhaseResult,
): LoopState {
  return {
    ...state,
    phaseResults: {
      ...state.phaseResults,
      [phaseName]: result,
    },
  };
}
