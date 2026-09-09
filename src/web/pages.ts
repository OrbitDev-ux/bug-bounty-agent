import { renderPage, card, badge, escapeHtml } from "./layout.js";
import { listPrograms, getProgram } from "../domain/programs.js";
import { listTasks } from "../domain/tasks.js";
import { listFindings, getFinding } from "../domain/findings.js";
import { listApprovals } from "../domain/approvals.js";
import { summarizeEarnings, summarizeEarningsByCurrency } from "../domain/earnings.js";
import { summarizeCostsByCurrency } from "../domain/costs.js";
import { listGoalProgress } from "../domain/goals.js";
import { listResearchSessions, getResearchSession } from "../domain/researchSessions.js";
import { listEvidenceForSession } from "../domain/sourceEvidence.js";
import { getSettings } from "../domain/settings.js";
import { getSchedulerState } from "../domain/schedulerState.js";
import { getAgentStatus, getProgramStats, getFindingStats, getProgramAnalytics, getRevenueTimelineForWindow, type TimelineWindow } from "../services/dashboard.js";
import { getMetrics, getROI } from "../services/metrics.js";
import { checkHealth } from "../services/health.js";
import { env } from "../config/env.js";
import { getDb } from "../db/client.js";

function scopeStaleBadge(policyLastVerifiedAt: string | null | undefined): string {
  if (!policyLastVerifiedAt) return badge("NEVER VERIFIED", "needs_review");
  const ageDays = (Date.now() - new Date(policyLastVerifiedAt).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays > 90) return badge("REVERIFICATION REQUIRED", "needs_review");
  return badge("fresh", "ok");
}

export async function renderOverview(): Promise<string> {
  const status = await getAgentStatus();
  const findingStats = getFindingStats();
  const programStats = getProgramStats();
  const earnings = summarizeEarnings();
  const reports = getMetrics().reportsDrafted;
  const accepted = getMetrics().accepted;
  const roi = getROI();

  const body = `
  <h2>Overview</h2>
  <div class="cards">
    ${card("Agent", badge(status.schedulerStatus.toUpperCase(), status.schedulerStatus === "running" ? "ok" : status.schedulerStatus === "paused" ? "pending" : "failed"))}
    ${card("Current Task", status.currentTaskId ? `<a href="/tasks">#${escapeHtml(status.currentTaskId.slice(0, 8))}</a>` : "none")}
    ${card("Queue", String(status.queueDepth))}
    ${card("Pending Approvals", String(status.pendingApprovals))}
    ${card("Programs", `${programStats.active} active / ${programStats.total}`)}
    ${card("Findings", String(findingStats.total))}
    ${card("Reports", String(reports))}
    ${card("Accepted", String(accepted))}
    ${card("Paid (nominal)", `$${earnings.allTime.toFixed(2)}`)}
    ${card("Revenue / Hour", roi.revenuePerHour !== null ? `$${roi.revenuePerHour.toFixed(2)}` : "n/a")}
    ${card("Pending Revenue", `$${earnings.pending.toFixed(2)}`)}
  </div>
  <p class="note">"Paid (nominal)" sums across currencies without conversion — see /earnings for a currency-correct breakdown.</p>
  `;
  return renderPage("Overview", "/", body);
}

export async function renderEarnings(window: TimelineWindow = "30d"): Promise<string> {
  const byCurrency = summarizeEarningsByCurrency();
  const costs = summarizeCostsByCurrency();
  const timeline = getRevenueTimelineForWindow(window);
  const goals = listGoalProgress();

  const windows: TimelineWindow[] = ["today", "7d", "30d", "90d", "all"];
  const windowLinks = windows.map((w) => `<a href="/earnings?window=${w}" class="nav-link${w === window ? " active" : ""}">${w}</a>`).join(" ");

  const currencyRows = byCurrency
    .map(
      (b) => `<tr><td>${escapeHtml(b.currency)}</td><td>${badge("PAID", "paid")} $${b.paid.toFixed(2)}</td><td>${badge("AWARDED", "pending")} ${b.awarded.toFixed(2)}</td><td>${badge("PENDING", "pending")} ${b.pending.toFixed(2)}</td></tr>`,
    )
    .join("");

  const netRows = byCurrency
    .map((b) => {
      const cost = costs.find((c) => c.currency === b.currency);
      const net = cost ? b.paid - cost.total : null;
      return `<tr><td>${escapeHtml(b.currency)}</td><td>$${b.paid.toFixed(2)}</td><td>${cost ? `$${cost.total.toFixed(2)}` : "Not Available"}</td><td>${net !== null ? `$${net.toFixed(2)}` : "Not Available"}</td></tr>`;
    })
    .join("");

  const timelineRows = timeline.map((p) => `<tr><td>${p.date}</td><td>${escapeHtml(p.currency)}</td><td>$${p.amount.toFixed(2)}</td></tr>`).join("");

  const goalRows = goals
    .map((g) => {
      const pct = Math.min(100, Math.round(g.progressRatio * 100));
      return `<tr><td>${escapeHtml(g.goal.name)}</td><td>${g.paidInGoalCurrency.toFixed(2)} / ${g.goal.targetAmount.toFixed(2)} ${escapeHtml(g.goal.targetCurrency)}</td><td>${pct}%</td></tr>`;
    })
    .join("");

  const body = `
  <h2>Revenue Intelligence</h2>
  <p class="note">CONFIRMED REVENUE = PAID. Awarded and Pending are shown separately and never counted as confirmed.</p>
  <table><tr><th>Currency</th><th>Paid</th><th>Awarded</th><th>Pending</th></tr>${currencyRows || "<tr><td colspan=4>No earnings yet.</td></tr>"}</table>

  <h2>Gross / Net (real measured costs only)</h2>
  <table><tr><th>Currency</th><th>Gross (Paid)</th><th>Tracked Costs</th><th>Net</th></tr>${netRows || "<tr><td colspan=4>No data yet.</td></tr>"}</table>

  <h2>Timeline</h2>
  <p>${windowLinks}</p>
  <table><tr><th>Date</th><th>Currency</th><th>Paid</th></tr>${timelineRows || "<tr><td colspan=3>No paid revenue in this window.</td></tr>"}</table>

  <h2>Goals</h2>
  <table><tr><th>Goal</th><th>Progress (paid / target)</th><th>%</th></tr>${goalRows || "<tr><td colspan=3>No goals set. Use <code>bba earnings goal-add</code>.</td></tr>"}</table>
  `;
  return renderPage("Earnings", "/earnings", body);
}

export function renderPrograms(): string {
  const programs = listPrograms();
  const rows = programs
    .map((p) => {
      const analytics = getProgramAnalytics(p.id);
      const revenue = analytics.paidRevenueByCurrency.map((r) => `$${r.total.toFixed(2)} ${r.currency}`).join(", ") || "$0";
      return `<tr>
        <td><a href="/programs/${p.id}">${escapeHtml(p.name)}</a></td>
        <td>${escapeHtml(p.platform)}</td>
        <td>${p.policy.automationAllowed ? badge("ALLOWED", "ok") : badge("NOT ALLOWED", "deny")}</td>
        <td>${scopeStaleBadge(p.policyLastVerifiedAt)}</td>
        <td>${analytics.reports}</td>
        <td>${revenue}</td>
      </tr>`;
    })
    .join("");

  const body = `
  <h2>Programs</h2>
  <table><tr><th>Name</th><th>Platform</th><th>Automation</th><th>Scope Freshness</th><th>Reports</th><th>Paid Revenue</th></tr>
  ${rows || "<tr><td colspan=6>No programs yet.</td></tr>"}</table>
  `;
  return renderPage("Programs", "/programs", body);
}

export function renderProgramDetail(programId: string): string | null {
  const program = getProgram(programId);
  if (!program) return null;
  const analytics = getProgramAnalytics(programId);
  const sessions = listResearchSessions().filter((s) => s.programId === programId);

  const body = `
  <h2>${escapeHtml(program.name)}</h2>
  <p class="muted">${escapeHtml(program.platform)} — <a href="${escapeHtml(program.url)}" target="_blank" rel="noopener">${escapeHtml(program.url)}</a></p>
  <div class="cards">
    ${card("Status", badge(program.status, program.status === "active" ? "ok" : "pending"))}
    ${card("Automation", program.policy.automationAllowed ? badge("ALLOWED", "ok") : badge("NOT ALLOWED", "deny"))}
    ${card("Last Verified", program.policyLastVerifiedAt ? new Date(program.policyLastVerifiedAt).toLocaleString() : "never")}
    ${card("Reports", String(analytics.reports))}
    ${card("Accepted", String(analytics.accepted))}
  </div>
  ${scopeStaleBadge(program.policyLastVerifiedAt)}
  <h2>Scope</h2>
  <p><b>In scope:</b> ${program.policy.inScope.map(escapeHtml).join(", ") || "(none published)"}</p>
  <p><b>Out of scope:</b> ${program.policy.outOfScope.map(escapeHtml).join(", ") || "(none published)"}</p>
  <h2>Bounty Stats</h2>
  <table><tr><th>Currency</th><th>Paid Revenue</th><th>Average</th><th>Median</th><th>Largest</th></tr>
  ${
    analytics.paidRevenueByCurrency
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.currency)}</td><td>$${r.total.toFixed(2)}</td><td>$${(analytics.averageBountyByCurrency.find((a) => a.currency === r.currency)?.average ?? 0).toFixed(2)}</td><td>$${(analytics.medianBountyByCurrency.find((a) => a.currency === r.currency)?.median ?? 0).toFixed(2)}</td><td>$${(analytics.largestBountyByCurrency.find((a) => a.currency === r.currency)?.amount ?? 0).toFixed(2)}</td></tr>`,
      )
      .join("") || "<tr><td colspan=5>No paid bounties yet.</td></tr>"
  }
  </table>
  <h2>Research Sessions</h2>
  <table><tr><th>Goal</th><th>Status</th><th>Started</th></tr>
  ${sessions.map((s) => `<tr><td><a href="/research/${s.id}">${escapeHtml(s.goal)}</a></td><td>${badge(s.status, s.status === "completed" ? "ok" : s.status === "failed" ? "failed" : "pending")}</td><td>${new Date(s.createdAt).toLocaleString()}</td></tr>`).join("") || "<tr><td colspan=3>No research yet.</td></tr>"}
  </table>
  `;
  return renderPage(program.name, "/programs", body);
}

export function renderResearchSessionDetail(sessionId: string): string | null {
  const session = getResearchSession(sessionId);
  if (!session) return null;
  const evidence = listEvidenceForSession(sessionId);

  const body = `
  <h2>Research Session</h2>
  <p class="muted">Goal: ${escapeHtml(session.goal)}</p>
  <div class="cards">
    ${card("Status", badge(session.status, session.status === "completed" ? "ok" : session.status === "failed" ? "failed" : "pending"))}
    ${card("Pages Visited", String(session.pagesVisited.length))}
    ${card("Sources", String(evidence.length))}
    ${card("Confidence", session.confidence !== null ? session.confidence.toFixed(2) : "n/a")}
  </div>
  <h2>Scope Findings</h2><p>${escapeHtml(session.scopeObservations) || "(none)"}</p>
  <h2>Policy Findings</h2><p>${escapeHtml(session.policyObservations) || "(none)"}</p>
  <h2>Summary</h2><p>${escapeHtml(session.summary) || "(none)"}</p>
  <h2>Pages Visited</h2>
  <table><tr><th>URL</th><th>Title</th></tr>${session.pagesVisited.map((p) => `<tr><td>${escapeHtml(p.url)}</td><td>${escapeHtml(p.title)}</td></tr>`).join("") || "<tr><td colspan=2>None recorded.</td></tr>"}</table>
  <h2>Sources</h2>
  <table><tr><th>Type</th><th>URL</th><th>Excerpt</th></tr>${evidence.map((e) => `<tr><td>${escapeHtml(e.sourceType)}</td><td>${escapeHtml(e.sourceUrl)}</td><td>${escapeHtml(e.relevantExcerpt).slice(0, 200)}</td></tr>`).join("") || "<tr><td colspan=3>None recorded.</td></tr>"}</table>
  `;
  return renderPage("Research Session", "/programs", body);
}

export function renderFindings(): string {
  const findings = listFindings();
  const rows = findings
    .map(
      (f) => `<tr>
        <td><a href="/findings/${f.id}">${escapeHtml(f.title)}</a></td>
        <td>${escapeHtml(f.category ?? "-")}</td>
        <td>${f.confidence !== null ? f.confidence.toFixed(2) : "-"}</td>
        <td>${escapeHtml(f.severityCandidate ?? "-")}</td>
        <td>${badge(f.status, f.status === "accepted" ? "ok" : f.status === "invalid" || f.status === "closed" ? "deny" : "pending")}</td>
        <td>${f.duplicateVerdict ? badge(f.duplicateVerdict, f.duplicateVerdict === "LIKELY_DUPLICATE" ? "deny" : "ok") : "-"}</td>
      </tr>`,
    )
    .join("");

  const body = `
  <h2>Findings</h2>
  <table><tr><th>Title</th><th>Category</th><th>Confidence</th><th>Severity</th><th>Status</th><th>Duplicate</th></tr>
  ${rows || "<tr><td colspan=6>No findings yet.</td></tr>"}</table>
  `;
  return renderPage("Findings", "/findings", body);
}

export function renderFindingDetail(findingId: string): string | null {
  const finding = getFinding(findingId);
  if (!finding) return null;
  const program = getProgram(finding.programId);
  const evidence = listEvidenceForSession(finding.researchSessionId ?? "");

  const body = `
  <h2>${escapeHtml(finding.title)}</h2>
  <p class="muted">${program ? escapeHtml(program.name) : "unknown program"} — asset: ${escapeHtml(finding.asset)}</p>
  <div class="cards">
    ${card("Status", badge(finding.status, finding.status === "accepted" ? "ok" : "pending"))}
    ${card("Category", escapeHtml(finding.category ?? "-"))}
    ${card("Confidence", finding.confidence !== null ? finding.confidence.toFixed(2) : "n/a")}
    ${card("Severity Candidate", escapeHtml(finding.severityCandidate ?? "-"))}
    ${card("Duplicate", finding.duplicateVerdict ?? "-")}
  </div>
  <h2>Summary</h2><p>${escapeHtml(finding.summary)}</p>
  <h2>Confidence Reason</h2><p>${escapeHtml(finding.confidenceReason ?? "-")}</p>
  <h2>Severity Reason</h2><p>${escapeHtml(finding.severityReason ?? "-")}</p>
  <h2>Evidence</h2>
  <table><tr><th>Type</th><th>URL</th><th>Excerpt</th></tr>${evidence.map((e) => `<tr><td>${escapeHtml(e.sourceType)}</td><td>${escapeHtml(e.sourceUrl)}</td><td>${escapeHtml(e.relevantExcerpt).slice(0, 200)}</td></tr>`).join("") || "<tr><td colspan=3>No evidence linked.</td></tr>"}</table>
  <p class="muted">Created: ${new Date(finding.createdAt).toLocaleString()} — Updated: ${new Date(finding.updatedAt).toLocaleString()}</p>
  `;
  return renderPage(finding.title, "/findings", body);
}

export function renderTasks(): string {
  const tasks = listTasks();
  const rows = tasks
    .map(
      (t) => `<tr>
        <td>${escapeHtml(t.type)}</td>
        <td>${escapeHtml(t.target)}</td>
        <td>${badge(t.status, t.status === "completed" ? "ok" : t.status === "failed" || t.status === "blocked" ? "failed" : "pending")}</td>
        <td>${escapeHtml(t.priority)}</td>
        <td>${new Date(t.createdAt).toLocaleString()}</td>
      </tr>`,
    )
    .join("");
  const body = `<h2>Task Queue</h2><table><tr><th>Type</th><th>Target</th><th>Status</th><th>Priority</th><th>Created</th></tr>${rows || "<tr><td colspan=5>No tasks.</td></tr>"}</table>`;
  return renderPage("Tasks", "/tasks", body);
}

export function renderApprovals(flash?: string): string {
  const pending = listApprovals("pending");
  const allowedIds = env.telegramAllowedUserIds;
  const idOptions = allowedIds.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("");

  const rows = pending
    .map(
      (a) => `<tr>
        <td>#${a.id.slice(0, 8)}</td>
        <td>${escapeHtml(a.requestedAction)}</td>
        <td>${a.expiresAt ? new Date(a.expiresAt).toLocaleString() : "never"}</td>
        <td>
          <form class="inline" method="post" action="/approvals/${a.id}/decide">
            <select name="telegramUserId" required>${idOptions || '<option value="">no allowlisted ids configured</option>'}</select>
            <button class="approve" name="decision" value="approve">Approve</button>
            <button class="reject" name="decision" value="reject">Reject</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");

  const body = `
  <h2>Approval Center</h2>
  <p class="note">Uses the same allowlist-checked decision path as Telegram — pick the Telegram user id you're deciding as.</p>
  <table><tr><th>ID</th><th>Requested Action</th><th>Expires</th><th>Decide</th></tr>${rows || "<tr><td colspan=4>No pending approvals.</td></tr>"}</table>
  `;
  return renderPage("Approvals", "/approvals", body, flash);
}

export async function renderAgent(flash?: string): Promise<string> {
  const scheduler = getSchedulerState();
  const health = await checkHealth();
  const healthRows = health.checks.map((c) => `<tr><td>${escapeHtml(c.component)}</td><td>${badge(c.status, c.status.toLowerCase())}</td><td>${escapeHtml(c.detail)}</td></tr>`).join("");

  const body = `
  <h2>Agent Operations</h2>
  <div class="cards">
    ${card("Scheduler", badge(scheduler.status.toUpperCase(), scheduler.status === "running" ? "ok" : scheduler.status === "paused" ? "pending" : "failed"))}
    ${card("Current Task", scheduler.currentTaskId ? `#${scheduler.currentTaskId.slice(0, 8)}` : "none")}
    ${card("Tasks This Run", String(scheduler.tasksRunThisRun))}
    ${card("Overall Health", badge(health.overall, health.overall.toLowerCase()))}
  </div>
  <form class="inline" method="post" action="/agent/pause"><button>Pause</button></form>
  <form class="inline" method="post" action="/agent/resume"><button>Resume</button></form>
  <form class="inline" method="post" action="/agent/run-once"><button>Run Once</button></form>
  <h2>Health</h2>
  <table><tr><th>Component</th><th>Status</th><th>Detail</th></tr>${healthRows}</table>
  `;
  return renderPage("Agent", "/agent", body, flash);
}

export function renderActivity(): string {
  const db = getDb();
  const rows = db.prepare("SELECT event, detail, created_at FROM agent_logs ORDER BY id DESC LIMIT 100").all() as { event: string; detail: string | null; created_at: string }[];
  const html = rows
    .map((r) => `<tr><td>${new Date(r.created_at).toLocaleString()}</td><td>${escapeHtml(r.event)}</td><td class="muted">${escapeHtml((r.detail ?? "").slice(0, 150))}</td></tr>`)
    .join("");
  const body = `<h2>Activity</h2><table><tr><th>When</th><th>Event</th><th>Detail</th></tr>${html || "<tr><td colspan=3>No activity recorded yet.</td></tr>"}</table>`;
  return renderPage("Activity", "/activity", body);
}

export function renderSettings(flash?: string): string {
  const s = getSettings();
  const body = `
  <h2>Settings</h2>
  <form method="post" action="/settings">
    <table>
      <tr><td>AI Model</td><td><input type="text" name="aiModel" value="${escapeHtml(s.aiModel)}"></td></tr>
      <tr><td>Notification Level</td><td>
        <select name="notificationLevel">
          <option value="all" ${s.notificationLevel === "all" ? "selected" : ""}>all</option>
          <option value="important" ${s.notificationLevel === "important" ? "selected" : ""}>important</option>
          <option value="none" ${s.notificationLevel === "none" ? "selected" : ""}>none</option>
        </select>
      </td></tr>
      <tr><td>Daily Summary</td><td><input type="checkbox" name="dailySummaryEnabled" ${s.dailySummaryEnabled ? "checked" : ""}></td></tr>
      <tr><td>Agent Auto Start</td><td><input type="checkbox" name="agentAutoStart" ${s.agentAutoStart ? "checked" : ""}></td></tr>
      <tr><td>Research Enabled</td><td><input type="checkbox" name="researchEnabled" ${s.researchEnabled ? "checked" : ""}></td></tr>
    </table>
    <button type="submit">Save</button>
  </form>
  <p class="note">Scope checks, policy enforcement, and human approval gates are not configurable here or anywhere else — always on.</p>
  `;
  return renderPage("Settings", "/settings", body, flash);
}
