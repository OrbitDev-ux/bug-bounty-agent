// AI Context Memory (project brief v0.3 section 32): builds a small,
// dynamically-fetched context for /chat — never the whole database. Used
// only to ground Claude's natural-language replies in AGENT_CHAT mode;
// never passed to /freechat.

import { getAgentStatus } from "../services/dashboard.js";
import { listApprovals } from "../domain/approvals.js";
import { listResearchSessions } from "../domain/researchSessions.js";
import { listTasks } from "../domain/tasks.js";
import { summarizeEarnings } from "../domain/earnings.js";

export async function buildAgentContext(): Promise<string> {
  const status = await getAgentStatus();
  const pending = listApprovals("pending").slice(0, 5);
  const recentSessions = listResearchSessions().slice(0, 3);
  const recentFailures = listTasks("failed").slice(0, 3);
  const earnings = summarizeEarnings();

  const lines = [
    `Scheduler status: ${status.schedulerStatus}`,
    `Current task: ${status.currentTaskId ?? "none"}`,
    `Queue depth: ${status.queueDepth}`,
    `Pending approvals: ${status.pendingApprovals}`,
    `Browser available: ${status.browserAvailable}`,
    `Last research goal: ${status.lastResearchGoal ?? "none yet"}`,
    `Earnings (paid, nominal): today=$${earnings.today.toFixed(2)} thisMonth=$${earnings.thisMonth.toFixed(2)} allTime=$${earnings.allTime.toFixed(2)} pending=$${earnings.pending.toFixed(2)}`,
  ];

  if (pending.length > 0) {
    lines.push("Pending approvals:");
    for (const a of pending) lines.push(`  #${a.id.slice(0, 8)}: ${a.requestedAction}`);
  }
  if (recentSessions.length > 0) {
    lines.push("Recent research sessions:");
    for (const s of recentSessions) lines.push(`  ${s.goal} (${s.status})`);
  }
  if (recentFailures.length > 0) {
    lines.push("Recent failed tasks:");
    for (const t of recentFailures) lines.push(`  ${t.type} on "${t.target}": ${t.failureReason ?? "unknown reason"}`);
  }

  return lines.join("\n");
}
