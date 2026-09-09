// Command Router (project brief v0.3 sections 9-11): classifies free-text
// chat input into a fixed set of intent categories. Classification is
// deterministic pattern matching, NOT an LLM call — the safety-critical
// distinction between "just talking" and "take an action" must not depend
// on a model call being well-calibrated or reproducible. An LLM is only
// ever used afterward, to phrase a natural-language reply around data this
// router (or a capability call) already fetched — never to decide whether
// something sensitive should happen.

import type { Capability, IntentCategory } from "../domain/types.js";
import { findPendingApprovalByRef } from "./capabilities.js";
import { listCandidates } from "../domain/programCandidates.js";

export interface ClassifiedIntent {
  category: IntentCategory;
  capability?: Capability;
  args?: Record<string, string>;
  reason: string;
}

interface Pattern {
  capability: Capability;
  category: IntentCategory;
  regex: RegExp;
}

// Korean + English keyword patterns. Order matters: more specific patterns
// (approval decisions, control actions) are checked before generic
// read-only queries, and unsafe-intent phrases are checked first of all so
// they can never be shadowed by a coincidentally-matching read pattern.
const UNSAFE_PATTERNS: RegExp[] = [
  /막\s*테스트|무제한.*(테스트|스캔)|scan\s+everything|bypass|우회해|크리덴셜|credential|계정\s*탈취|account\s*takeover|디도스|ddos|서비스\s*중단|무작위로.*(공격|테스트)/i,
];

const APPROVAL_PATTERNS: RegExp[] = [
  /^#?([a-f0-9-]{4,})\s*(승인|거절|approve|reject)/i,
  /(승인|거절|approve|reject)\s*#?([a-f0-9-]{4,})/i,
];

const CONTROL_PATTERNS: Pattern[] = [
  { capability: "CONTROL_AGENT_PAUSE", category: "CONTROL_ACTION", regex: /agent\s*(멈춰|중지|stop|pause)|멈춰|중지해|일시\s*정지/i },
  { capability: "CONTROL_AGENT_RESUME", category: "CONTROL_ACTION", regex: /재개|다시\s*시작|resume|restart\b/i },
  // Broader "just start working" phrasing — matched separately from RESUME
  // so the reply can say "started" rather than "resumed" when nothing was
  // paused in the first place. Both capabilities end up doing the same
  // real thing (ensuring a worker process is actually running) — see
  // CONTROL_AGENT_RESUME's handler in capabilities.ts.
  { capability: "CONTROL_AGENT_START", category: "CONTROL_ACTION", regex: /작업\s*시작|일\s*시작|자동화\s*시작|버그바운티.*시작|start\s*(the\s*)?(agent|worker|automation)|계속해/i },
];

/**
 * Program candidate discovery/research (section 3-9 of the v0.3.2 brief).
 * Deliberately checked before READ_PATTERNS: a message like "candidate 조사해줘"
 * would otherwise false-positive-match READ_FINDINGS' "candidate" keyword.
 * If an existing candidate's name is mentioned, treat it as a deep-research
 * request for that specific candidate; otherwise treat the whole phrase
 * (minus the trigger word) as a fresh discovery search topic.
 */
const RESEARCH_TRIGGER_PATTERN = /조사해\S*|리서치\S*|찾아줘|찾아봐|research\b|검색해\S*/i;

function classifyResearchIntent(trimmed: string): ClassifiedIntent | null {
  if (!RESEARCH_TRIGGER_PATTERN.test(trimmed)) return null;

  const lower = trimmed.toLowerCase();
  const existing = listCandidates().find((c) => c.name.length >= 3 && lower.includes(c.name.toLowerCase()));
  if (existing) {
    return {
      category: "RESEARCH_ACTION",
      capability: "CANDIDATE_RESEARCH",
      args: { candidateId: existing.id },
      reason: `Matched a research request for existing candidate "${existing.name}".`,
    };
  }

  const topic = trimmed.replace(RESEARCH_TRIGGER_PATTERN, " ").replace(/\s+/g, " ").trim();
  if (topic.length >= 2) {
    return { category: "RESEARCH_ACTION", capability: "CANDIDATE_DISCOVER", args: { topic }, reason: `Matched a discovery request with topic "${topic}".` };
  }
  return null;
}

const READ_PATTERNS: Pattern[] = [
  { capability: "READ_APPROVALS", category: "READ_ONLY_QUERY", regex: /승인\s*대기|approvals?\b|대기\s*중인\s*작업/i },
  { capability: "READ_EARNINGS", category: "READ_ONLY_QUERY", regex: /수익|얼마|earnings?\b|paid\b|revenue/i },
  { capability: "READ_TASKS", category: "READ_ONLY_QUERY", regex: /작업\s*큐|태스크|tasks?\b|queue\b|큐\s*보여/i },
  { capability: "READ_FINDINGS", category: "READ_ONLY_QUERY", regex: /findings?\b|취약점\s*후보|candidate/i },
  { capability: "READ_PROGRAMS", category: "READ_ONLY_QUERY", regex: /programs?\b|프로그램\s*목록/i },
  { capability: "READ_STATUS", category: "READ_ONLY_QUERY", regex: /뭐\s*하고\s*있어|지금\s*상태|현재\s*상태|status\b|what.*doing/i },
];

export function classifyIntent(text: string): ClassifiedIntent {
  const trimmed = text.trim();

  for (const re of UNSAFE_PATTERNS) {
    if (re.test(trimmed)) {
      return { category: "UNSAFE_ACTION", reason: "Matched an out-of-scope/destructive/policy-bypassing phrase." };
    }
  }

  for (const re of APPROVAL_PATTERNS) {
    const match = trimmed.match(re);
    if (match) {
      const ref = match[1] && /[a-f0-9-]{4,}/i.test(match[1]) ? match[1] : match[2];
      const decisionWord = match[0];
      const decision = /승인|approve/i.test(decisionWord) ? "approved" : "rejected";
      const approval = ref ? findPendingApprovalByRef(ref) : null;
      if (!approval) {
        return { category: "UNKNOWN", reason: `Looked like an approval decision but no pending approval matched "${ref}".` };
      }
      return {
        category: "APPROVAL_ACTION",
        capability: "DECIDE_APPROVAL",
        args: { approvalId: approval.id, decision },
        reason: `Matched an approval decision for ${approval.id.slice(0, 8)}.`,
      };
    }
  }

  for (const p of CONTROL_PATTERNS) {
    if (p.regex.test(trimmed)) {
      return { category: p.category, capability: p.capability, reason: `Matched a control-action phrase for ${p.capability}.` };
    }
  }

  const researchIntent = classifyResearchIntent(trimmed);
  if (researchIntent) return researchIntent;

  for (const p of READ_PATTERNS) {
    if (p.regex.test(trimmed)) {
      return { category: p.category, capability: p.capability, reason: `Matched a read-only query phrase for ${p.capability}.` };
    }
  }

  return { category: "CHAT", reason: "No structured intent matched — treat as open conversation." };
}
