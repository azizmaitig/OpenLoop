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

/**
 * Execute an MCP phase by spawning the configured MCP server binary and
 * sending a JSON-RPC 2.0 tool call request.
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

  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: '1',
    method: 'tools/call',
    params: { name: tool, arguments: parsedArgs },
  });

  try {
    return await executeWithTimeout(async (signal) => {
      const proc = Bun.spawn([mcpServer], {
        stdio: ['pipe', 'pipe', 'pipe'],
        signal,
      });

      // Write the JSON-RPC request to stdin and close
      const writer = (proc.stdin as any).getWriter();
      await writer.write(new TextEncoder().encode(request));
      await writer.close();

      // Collect stdout and stderr (may fail after abort — caught below)
      let stdout = '';
      let stderr = '';
      try {
        [stdout, stderr] = await Promise.all([
          Bun.readableStreamToText(proc.stdout),
          Bun.readableStreamToText(proc.stderr),
        ]);
      } catch {
        // Stream read may reject after process is killed by abort signal
      }

      const exitCode = await proc.exited;
      const durationMs = Math.round(performance.now() - startTime);

      // If the process failed and we have no stdout to parse, report error
      if (exitCode !== 0 && !stdout) {
        return {
          status: 'error' as const,
          exitCode,
          stdout,
          stderr: stderr || `MCP process exited with code ${exitCode}`,
          durationMs,
          evidencePath: '',
        };
      }

      // Parse the JSON-RPC response
      try {
        const response = JSON.parse(stdout);

        if (response.result) {
          return {
            status: 'pass' as const,
            exitCode: 0,
            stdout: JSON.stringify(response.result),
            stderr,
            durationMs,
            evidencePath: '',
          };
        }

        if (response.error) {
          const errMsg =
            typeof response.error === 'string'
              ? response.error
              : response.error.message || JSON.stringify(response.error);
          return {
            status: 'fail' as const,
            exitCode: -1,
            stdout,
            stderr: errMsg,
            durationMs,
            evidencePath: '',
          };
        }

        // Response present but missing both result and error
        return {
          status: 'error' as const,
          exitCode: -1,
          stdout,
          stderr: 'MCP response missing result and error fields',
          durationMs,
          evidencePath: '',
        };
      } catch {
        return {
          status: 'error' as const,
          exitCode,
          stdout,
          stderr: `Failed to parse MCP JSON-RPC response: ${stdout.slice(0, 500)}`,
          durationMs,
          evidencePath: '',
        };
      }
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

    // Everything else (spawn failure, unexpected crash, etc.)
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
