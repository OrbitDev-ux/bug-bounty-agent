import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import type { Report } from "./types.js";

interface ReportRow {
  id: string;
  finding_id: string;
  title: string;
  program: string;
  asset: string;
  summary: string;
  impact: string;
  steps_to_reproduce: string;
  evidence: string;
  expected_behavior: string;
  observed_behavior: string;
  suggested_remediation: string;
  references: string;
  created_at: string;
  updated_at: string;
}

function rowToReport(row: ReportRow): Report {
  return {
    id: row.id,
    findingId: row.finding_id,
    title: row.title,
    program: row.program,
    asset: row.asset,
    summary: row.summary,
    impact: row.impact,
    stepsToReproduce: row.steps_to_reproduce,
    evidence: row.evidence,
    expectedBehavior: row.expected_behavior,
    observedBehavior: row.observed_behavior,
    suggestedRemediation: row.suggested_remediation,
    references: row.references,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CreateReportInput = Omit<Report, "id" | "createdAt" | "updatedAt">;

export function createReport(input: CreateReportInput): Report {
  const db = getDb();
  const now = new Date().toISOString();
  const report: Report = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
  db.prepare(
    `INSERT INTO reports (id, finding_id, title, program, asset, summary, impact, steps_to_reproduce, evidence, expected_behavior, observed_behavior, suggested_remediation, "references", created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    report.id,
    report.findingId,
    report.title,
    report.program,
    report.asset,
    report.summary,
    report.impact,
    report.stepsToReproduce,
    report.evidence,
    report.expectedBehavior,
    report.observedBehavior,
    report.suggestedRemediation,
    report.references,
    report.createdAt,
    report.updatedAt,
  );
  return report;
}

export function getReport(id: string): Report | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as ReportRow | undefined;
  return row ? rowToReport(row) : null;
}

export function getReportByFinding(findingId: string): Report | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM reports WHERE finding_id = ? ORDER BY created_at DESC LIMIT 1").get(findingId) as
    | ReportRow
    | undefined;
  return row ? rowToReport(row) : null;
}

export function listReports(): Report[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM reports ORDER BY created_at DESC, rowid DESC").all() as unknown as ReportRow[];
  return rows.map(rowToReport);
}

/** Renders the report as the plain-text structure requested in section 22. */
export function renderReportText(report: Report): string {
  return [
    `Title: ${report.title}`,
    `Program: ${report.program}`,
    `Asset: ${report.asset}`,
    "",
    "## Summary",
    report.summary,
    "",
    "## Impact",
    report.impact,
    "",
    "## Steps to Reproduce",
    report.stepsToReproduce,
    "",
    "## Evidence",
    report.evidence,
    "",
    "## Expected Behavior",
    report.expectedBehavior,
    "",
    "## Observed Behavior",
    report.observedBehavior,
    "",
    "## Suggested Remediation",
    report.suggestedRemediation,
    "",
    "## References",
    report.references,
  ].join("\n");
}
