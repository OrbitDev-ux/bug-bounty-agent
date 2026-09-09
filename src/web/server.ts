#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  renderOverview,
  renderEarnings,
  renderPrograms,
  renderProgramDetail,
  renderResearchSessionDetail,
  renderFindings,
  renderFindingDetail,
  renderTasks,
  renderApprovals,
  renderAgent,
  renderActivity,
  renderSettings,
} from "./pages.js";
import { handleApprovalDecision } from "../telegram/approvalHandler.js";
import { updateSettings } from "../domain/settings.js";
import { pauseAgent, resumeAgent, runOnce } from "../agent/scheduler.js";
import { log } from "../logging/logger.js";
import type { TimelineWindow } from "../services/dashboard.js";

/**
 * Minimal, dependency-free HTTP server (project brief section 13: reuse the
 * current stack, don't introduce a new framework — there is no existing web
 * framework in this project, so this uses only Node's built-in `http`).
 * Server-rendered HTML, full-page-post forms, no client JS required for any
 * action. Binds to 127.0.0.1 ONLY — this is a local, single-operator
 * dashboard with no authentication of its own; see docs/dashboard.md for
 * why that's an intentional boundary, not an oversight.
 */

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/**
 * CSRF mitigation (found during the security review, section 40-class
 * issue): this server has no auth of its own beyond the Telegram allowlist
 * check on the one state-changing decide endpoint — a malicious page open
 * in the SAME browser as the dashboard could otherwise auto-submit a POST
 * to 127.0.0.1. Browsers attach an Origin header to cross-origin form
 * submissions; reject any POST whose Origin doesn't match this server. A
 * request with no Origin header (curl, the CLI, same-origin fetches in
 * some older browsers) is allowed through — this only blocks the
 * browser-enforced cross-origin case, which is the actual CSRF threat model
 * here. Documented residual risk in docs/dashboard.md.
 */
export function isSameOriginOrNoOrigin(req: IncomingMessage, host: string, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://${host}:${port}` || origin === `http://localhost:${port}`;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, host: string, port: number): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "POST" && !isSameOriginOrNoOrigin(req, host, port)) {
    return sendHtml(res, 403, "Cross-origin POST rejected.");
  }

  try {
    if (method === "GET" && path === "/") return sendHtml(res, 200, await renderOverview());

    if (method === "GET" && path === "/earnings") {
      const window = (url.searchParams.get("window") as TimelineWindow) || "30d";
      return sendHtml(res, 200, await renderEarnings(window));
    }

    if (method === "GET" && path === "/programs") return sendHtml(res, 200, renderPrograms());

    const programMatch = path.match(/^\/programs\/([^/]+)$/);
    if (method === "GET" && programMatch) {
      const html = renderProgramDetail(programMatch[1]!);
      return html ? sendHtml(res, 200, html) : sendHtml(res, 404, "Program not found");
    }

    const sessionMatch = path.match(/^\/research\/([^/]+)$/);
    if (method === "GET" && sessionMatch) {
      const html = renderResearchSessionDetail(sessionMatch[1]!);
      return html ? sendHtml(res, 200, html) : sendHtml(res, 404, "Research session not found");
    }

    if (method === "GET" && path === "/findings") return sendHtml(res, 200, renderFindings());

    const findingMatch = path.match(/^\/findings\/([^/]+)$/);
    if (method === "GET" && findingMatch) {
      const html = renderFindingDetail(findingMatch[1]!);
      return html ? sendHtml(res, 200, html) : sendHtml(res, 404, "Finding not found");
    }

    if (method === "GET" && path === "/tasks") return sendHtml(res, 200, renderTasks());

    if (method === "GET" && path === "/approvals") return sendHtml(res, 200, renderApprovals());

    const decideMatch = path.match(/^\/approvals\/([^/]+)\/decide$/);
    if (method === "POST" && decideMatch) {
      const body = await readBody(req);
      const telegramUserId = body.get("telegramUserId") ?? "";
      const decision = body.get("decision") === "approve" ? "approved" : "rejected";
      const result = handleApprovalDecision(decideMatch[1]!, decision, telegramUserId);
      log("approval_requested", { note: "decided via web dashboard", ok: result.ok });
      return sendHtml(res, 200, renderApprovals(result.reason));
    }

    if (method === "GET" && path === "/agent") return sendHtml(res, 200, await renderAgent());

    if (method === "POST" && path === "/agent/pause") {
      try {
        pauseAgent();
        return sendHtml(res, 200, await renderAgent("Agent paused."));
      } catch (err) {
        return sendHtml(res, 200, await renderAgent((err as Error).message));
      }
    }
    if (method === "POST" && path === "/agent/resume") {
      try {
        resumeAgent();
        return sendHtml(res, 200, await renderAgent("Agent resumed."));
      } catch (err) {
        return sendHtml(res, 200, await renderAgent((err as Error).message));
      }
    }
    if (method === "POST" && path === "/agent/run-once") {
      const result = await runOnce();
      return sendHtml(res, 200, await renderAgent(result.ranTask ? `Ran task ${result.taskId}: ${result.outcome}` : "Nothing to do — queue is empty."));
    }

    if (method === "GET" && path === "/activity") return sendHtml(res, 200, renderActivity());

    if (method === "GET" && path === "/settings") return sendHtml(res, 200, renderSettings());
    if (method === "POST" && path === "/settings") {
      const body = await readBody(req);
      updateSettings({
        aiModel: body.get("aiModel") || undefined,
        notificationLevel: (body.get("notificationLevel") as "all" | "important" | "none") || undefined,
        dailySummaryEnabled: body.has("dailySummaryEnabled"),
        agentAutoStart: body.has("agentAutoStart"),
        researchEnabled: body.has("researchEnabled"),
      });
      return redirect(res, "/settings");
    }

    sendHtml(res, 404, "Not found");
  } catch (err) {
    sendHtml(res, 500, `<pre>${(err as Error).message}</pre>`);
  }
}

export function startWebDashboard(port = 4173, host = "127.0.0.1") {
  const server = createServer((req, res) => {
    void handleRequest(req, res, host, port);
  });
  server.listen(port, host, () => {
    console.log(`Web dashboard listening on http://${host}:${port}`);
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.WEB_PORT ? Number(process.env.WEB_PORT) : 4173;
  startWebDashboard(port);
}
