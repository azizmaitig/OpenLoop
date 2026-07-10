/**
 * MCP dispatch module — executes an MCP tool call from a PhaseDef.
 *
 * Spawns the configured MCP server as a subprocess, sends a JSON-RPC
 * request over stdin, and parses the response from stdout.
 *
 * @module mcp
 */

import type { PhaseDef, PhaseResult } from './types.js';
import { executeWithTimeout } from './safety.js';
import { send } from './json-rpc.js';

/**
 * Execute an MCP phase by spawning the configured MCP server binary and
 * sending a JSON-RPC 2.0 tool call request via the json-rpc transport layer.
 *
 * @param phase - Phase definition containing the MCP server/tool/prompt config
 * @returns Result of the MCP tool invocation
 */
export async function executeMcpPhase(phase: PhaseDef): Promise<PhaseResult> {
  // No LLM/MCP config → early error
  if (!phase.llm) {
    return {
      status: 'error',
      exitCode: -1,
      stdout: '',
      stderr: 'No LLM/MCP configuration in phase',
      durationMs: 0,
      evidencePath: '',
    };
  }

  // Guard: this function only supports the MCP config shape
  if (!('mcpServer' in phase.llm)) {
    return {
      status: 'error',
      exitCode: -1,
      stdout: '',
      stderr: 'Phase llm config is not an MCP configuration (missing mcpServer)',
      durationMs: 0,
      evidencePath: '',
    };
  }

  const startTime = performance.now();
  const { mcpServer, tool, prompt } = phase.llm;

  // Build the JSON-RPC request payload.
  // If the prompt is valid JSON, use it as the arguments object directly;
  // otherwise pass it as a plain { prompt } so the tool still receives input.
  let parsedArgs: Record<string, unknown>;
  try {
    parsedArgs = JSON.parse(prompt);
  } catch {
    parsedArgs = { prompt };
  }

  const request = {
    jsonrpc: '2.0' as const,
    id: '1',
    method: 'tools/call',
    params: { name: tool, arguments: parsedArgs },
  };

  try {
    return await executeWithTimeout(async (signal) => {
      const response = await send(mcpServer, [], request, { signal });

      const durationMs = Math.round(performance.now() - startTime);

      if ('result' in response) {
        return {
          status: 'pass',
          exitCode: 0,
          stdout: JSON.stringify(response.result),
          stderr: '',
          durationMs,
          evidencePath: '',
        };
      }

      // JSON-RPC error response
      const errMsg =
        typeof response.error === 'string'
          ? response.error
          : response.error.message || JSON.stringify(response.error);
      return {
        status: 'fail',
        exitCode: -1,
        stdout: '',
        stderr: errMsg,
        durationMs,
        evidencePath: '',
      };
    }, phase.timeoutMs, phase.name);
  } catch (err) {
    const durationMs = Math.round(performance.now() - startTime);

    // Timeout is already a structured error from executeWithTimeout
    if (err instanceof Error && err.name === 'PhaseTimeoutError') {
      return {
        status: 'error',
        exitCode: -1,
        stdout: '',
        stderr: err.message,
        durationMs,
        evidencePath: '',
      };
    }

    // Everything else (spawn failure, process crash, parse failure, etc.)
    return {
      status: 'error',
      exitCode: -1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      durationMs,
      evidencePath: '',
    };
  }
}
