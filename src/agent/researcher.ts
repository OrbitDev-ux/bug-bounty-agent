import { runClaude } from "./claudeRuntime.js";
import { env } from "../config/env.js";
import type { ProgramPolicy } from "../domain/types.js";

const SAFARI_READ_TOOLS = [
  "mcp__safari__safari_open",
  "mcp__safari__safari_open_url",
  "mcp__safari__safari_search",
  "mcp__safari__safari_current_tab",
  "mcp__safari__safari_page_title",
  "mcp__safari__safari_page_url",
  "mcp__safari__safari_page_text",
  "mcp__safari__safari_get_links",
  "mcp__safari__safari_find_text",
];

const POLICY_JSON_SCHEMA = {
  type: "object",
  properties: {
    programFound: { type: "boolean" },
    inScope: {
      type: "array",
      items: { type: "string" },
      description: "Bare domain patterns only, e.g. 'example.com' or '*.example.com'. No prose, no product names, no explanatory clauses.",
    },
    outOfScope: {
      type: "array",
      items: { type: "string" },
      description: "Bare domain patterns only, same format as inScope. No prose.",
    },
    allowedMethods: { type: "array", items: { type: "string" } },
    forbiddenMethods: { type: "array", items: { type: "string" } },
    automationAllowed: { type: "boolean" },
    restrictions: {
      type: "array",
      items: { type: "string" },
      description: "Free-text restriction notes. Anything that doesn't fit the bare-domain inScope/outOfScope format (named products, apps, conditions, exceptions) goes here instead.",
    },
    notes: { type: "string" },
  },
  required: ["programFound", "inScope", "outOfScope", "allowedMethods", "forbiddenMethods", "automationAllowed", "restrictions", "notes"],
} as const;

export interface PolicyExtractionResult {
  ok: boolean;
  policy: ProgramPolicy | null;
  notes: string;
  costUsd: number;
  error?: string;
}

/**
 * Research role: opens a program's published policy page via the Safari MCP
 * server (read-only tools only) and asks Claude to extract scope/policy into
 * our schema. This is the "Policy reading / Scope extraction" automated step
 * from the project brief — it never touches anything out of scope itself,
 * it only reads a page the human already pointed it at.
 */
export async function extractProgramPolicy(programUrl: string): Promise<PolicyExtractionResult> {
  const prompt = [
    `Open ${programUrl} in Safari using safari_open_url, then read its content with safari_page_text`,
    `(and safari_get_links if the policy/scope is on a linked page). This is a public bug bounty`,
    `program policy page. Extract ONLY what is explicitly published, and do not infer or guess scope`,
    `that isn't stated on the page. IMPORTANT: inScope and outOfScope must contain ONLY bare domain`,
    `patterns (e.g. "example.com" or "*.example.com") — one domain per array entry, nothing else.`,
    `If an entry is a named product/app rather than a domain (e.g. "GitHub CLI"), or has conditions,`,
    `exceptions, or explanatory text attached, put that detail in restrictions instead and leave it`,
    `out of inScope/outOfScope. Also extract allowed testing methods, forbidden testing methods, and`,
    `whether automated tooling/scanning is explicitly permitted (default to false if not clearly stated).`,
    `If you cannot find a program or policy at this URL, set programFound to false.`,
  ].join(" ");

  const result = await runClaude({
    prompt,
    mcpConfigPath: env.safariMcpEntrypointMcpConfig,
    allowedTools: SAFARI_READ_TOOLS,
    jsonSchema: POLICY_JSON_SCHEMA,
    maxBudgetUsd: 0.75,
    timeoutMs: 180_000,
  });

  if (!result.ok || !result.structuredOutput) {
    return { ok: false, policy: null, notes: "", costUsd: result.costUsd, error: result.error ?? "No structured output returned." };
  }

  const out = result.structuredOutput as {
    programFound: boolean;
    inScope: string[];
    outOfScope: string[];
    allowedMethods: string[];
    forbiddenMethods: string[];
    automationAllowed: boolean;
    restrictions: string[];
    notes: string;
  };

  if (!out.programFound) {
    return { ok: false, policy: null, notes: out.notes, costUsd: result.costUsd, error: "Program/policy not found at URL." };
  }

  return {
    ok: true,
    policy: {
      inScope: out.inScope,
      outOfScope: out.outOfScope,
      allowedMethods: out.allowedMethods,
      forbiddenMethods: out.forbiddenMethods,
      automationAllowed: out.automationAllowed,
      restrictions: out.restrictions,
    },
    notes: out.notes,
    costUsd: result.costUsd,
  };
}

export interface CandidateSearchResult {
  ok: boolean;
  summary: string;
  costUsd: number;
  error?: string;
}

/**
 * Research role: public web search for candidate bug bounty programs on a
 * given topic/platform, via Safari MCP (search + read only). Returns a
 * free-text summary for a human to review — this step never creates a
 * Program on its own.
 */
export async function researchCandidatePrograms(topic: string): Promise<CandidateSearchResult> {
  const prompt = [
    `Use safari_search to search the public web for: ${topic}.`,
    `Open a couple of the most relevant public results with safari_open_url and skim them with safari_page_text.`,
    `Summarize candidate bug bounty programs you found: name, platform, and the URL of their public policy/scope page.`,
    `Only report programs with a publicly discoverable policy page. Do not visit or scan anything beyond reading these public pages.`,
  ].join(" ");

  const result = await runClaude({
    prompt,
    mcpConfigPath: env.safariMcpEntrypointMcpConfig,
    allowedTools: SAFARI_READ_TOOLS,
    maxBudgetUsd: 0.75,
    timeoutMs: 180_000,
  });

  return { ok: result.ok, summary: result.text, costUsd: result.costUsd, error: result.error };
}
