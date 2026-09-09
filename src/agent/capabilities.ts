// Capability Gate (project brief v0.3 section 11): AI chat never gets direct
// tool/DB access. It can only trigger one of these fixed, enumerable
// capabilities — never freeform code execution, never a raw shell command
// built from user text (section 53).

import { listTasks } from "../domain/tasks.js";
import { listFindings } from "../domain/findings.js";
import { listApprovals } from "../domain/approvals.js";
import { listPrograms } from "../domain/programs.js";
import { summarizeEarnings, summarizeEarningsByCurrency } from "../domain/earnings.js";
import { getAgentStatus } from "../services/dashboard.js";
import { pauseAgent, resumeAgent } from "./scheduler.js";
import { handleApprovalDecision } from "../telegram/approvalHandler.js";
import type { Capability } from "../domain/types.js";

export interface CapabilityResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

/**
 * Executes exactly one capability. This is the ONLY function the chat layer
 * is allowed to call to make anything happen — every capability here maps
 * to an existing, already-guarded domain/service function. Nothing here
 * takes a raw string and evaluates or execs it.
 */
export async function executeCapability(capability: Capability, args: Record<string, string> = {}): Promise<CapabilityResult> {
  switch (capability) {
    case "READ_STATUS": {
      const status = await getAgentStatus();
      return { ok: true, summary: "agent status", data: status };
    }
    case "READ_TASKS": {
      const tasks = listTasks();
      return { ok: true, summary: `${tasks.length} task(s)`, data: tasks.slice(0, 10) };
    }
    case "READ_FINDINGS": {
      const findings = listFindings();
      return { ok: true, summary: `${findings.length} finding(s)`, data: findings.slice(0, 10) };
    }
    case "READ_EARNINGS": {
      const summary = summarizeEarnings();
      const byCurrency = summarizeEarningsByCurrency();
      return { ok: true, summary: "earnings summary", data: { summary, byCurrency } };
    }
    case "READ_APPROVALS": {
      const approvals = listApprovals("pending");
      return { ok: true, summary: `${approvals.length} pending approval(s)`, data: approvals };
    }
    case "READ_PROGRAMS": {
      const programs = listPrograms();
      return { ok: true, summary: `${programs.length} program(s)`, data: programs };
    }
    case "CONTROL_AGENT_PAUSE": {
      try {
        const state = pauseAgent();
        return { ok: true, summary: "agent paused", data: state };
      } catch (err) {
        return { ok: false, summary: (err as Error).message };
      }
    }
    case "CONTROL_AGENT_RESUME": {
      try {
        const state = resumeAgent();
        return { ok: true, summary: "agent resumed", data: state };
      } catch (err) {
        return { ok: false, summary: (err as Error).message };
      }
    }
    case "DECIDE_APPROVAL": {
      const approvalId = args.approvalId;
      const decision = args.decision === "approved" ? "approved" : "rejected";
      const telegramUserId = args.telegramUserId;
      if (!approvalId || !telegramUserId) {
        return { ok: false, summary: "missing approvalId or telegramUserId" };
      }
      const result = handleApprovalDecision(approvalId, decision, telegramUserId);
      return { ok: result.ok, summary: result.reason, data: result.approval };
    }
    default: {
      const exhaustive: never = capability;
      return { ok: false, summary: `unknown capability: ${String(exhaustive)}` };
    }
  }
}

/** Resolves a short reference ("184", "#184", a full UUID) to a pending approval, for chat-based approval commands. */
export function findPendingApprovalByRef(ref: string) {
  const cleaned = ref.replace(/^#/, "").trim();
  const pending = listApprovals("pending");
  return (
    pending.find((a) => a.id === cleaned) ??
    pending.find((a) => a.id.startsWith(cleaned)) ??
    pending.find((a) => a.findingId?.startsWith(cleaned)) ??
    pending.find((a) => a.taskId?.startsWith(cleaned)) ??
    null
  );
}
