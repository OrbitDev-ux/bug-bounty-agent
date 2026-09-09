import { spawn } from "node:child_process";
import { env } from "../config/env.js";
import { getSettings } from "../domain/settings.js";
import { recordClaudeCost } from "../services/costTracking.js";

/**
 * Thin wrapper around the local `claude` CLI in non-interactive mode
 * (`claude -p ... --output-format json`), verified against the installed
 * Claude Code CLI in this environment. This IS the Claude Agent runtime for
 * v0.1 — no separate SDK/API key management, it reuses whatever
 * authentication the local `claude` CLI already has.
 */

export interface ClaudeRunOptions {
  prompt: string;
  /** Path to an MCP config JSON (e.g. mcp/safari.mcp.json). Omit for no tool access. */
  mcpConfigPath?: string;
  /** Exact tool names to pre-approve, e.g. "mcp__safari__safari_open_url". Required whenever mcpConfigPath is set. */
  allowedTools?: string[];
  systemPrompt?: string;
  maxBudgetUsd?: number;
  model?: string;
  timeoutMs?: number;
  /** JSON Schema object. When set, the CLI validates/coerces the reply and returns it in structuredOutput. */
  jsonSchema?: object;
}

export interface ClaudeRunResult {
  ok: boolean;
  text: string;
  structuredOutput: unknown;
  costUsd: number;
  numTurns: number;
  sessionId: string | null;
  error?: string;
}

interface ClaudeCliJson {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  session_id?: string;
  error?: string;
  errors?: string[];
}

export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "json",
    "--no-session-persistence",
    "--model",
    // Precedence: explicit call-site override > live operator setting
    // (/settings, `bba settings set`) > .env default. The settings row
    // always has a value (getSettings() seeds defaults on first read), so
    // env.claudeModel is really just the seed for that default.
    opts.model ?? getSettings().aiModel ?? env.claudeModel,
    "--max-budget-usd",
    String(opts.maxBudgetUsd ?? env.claudeMaxBudgetUsd),
  ];

  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }

  // Defense in depth: research/report calls never get filesystem or shell access,
  // regardless of what else is allowed below.
  args.push("--disallowedTools", "Bash Edit Write NotebookEdit BashOutput KillShell");

  if (opts.mcpConfigPath) {
    if (!opts.allowedTools || opts.allowedTools.length === 0) {
      throw new Error("mcpConfigPath was set without allowedTools — refusing to grant unscoped tool access.");
    }
    args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config", "--allowedTools", opts.allowedTools.join(" "));
  }

  if (opts.jsonSchema) {
    args.push("--json-schema", JSON.stringify(opts.jsonSchema));
  }

  const { stdout, stderr, code, timedOut } = await execClaude(args, opts.timeoutMs ?? 120_000);
  const empty = { text: "", structuredOutput: null, costUsd: 0, numTurns: 0, sessionId: null };

  if (timedOut) {
    return { ok: false, ...empty, error: "claude CLI timed out" };
  }
  if (code !== 0 && !stdout) {
    return { ok: false, ...empty, error: stderr.trim() || `claude exited with code ${code}` };
  }

  let parsed: ClaudeCliJson;
  try {
    parsed = JSON.parse(stdout) as ClaudeCliJson;
  } catch {
    return { ok: false, ...empty, error: `Could not parse claude CLI output: ${stdout.slice(0, 500)}` };
  }

  const base = {
    text: parsed.result ?? "",
    structuredOutput: parsed.structured_output ?? null,
    costUsd: parsed.total_cost_usd ?? 0,
    numTurns: parsed.num_turns ?? 0,
    sessionId: parsed.session_id ?? null,
  };

  recordClaudeCost(base.costUsd, `claude -p (model=${opts.model ?? "default"}, ${opts.mcpConfigPath ? "with MCP" : "no MCP"})`);

  if (parsed.is_error) {
    return { ok: false, ...base, error: parsed.errors?.join("; ") ?? parsed.error ?? "claude reported is_error=true" };
  }

  return { ok: true, ...base };
}

function execClaude(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn("claude", args);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutMs);

    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}
