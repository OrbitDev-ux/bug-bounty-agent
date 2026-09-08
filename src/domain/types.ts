// Shared domain types for Bug Bounty Agent v0.1.
// Kept intentionally small — this is the vocabulary every module (db, scope,
// queue, telegram, cli) shares, not a place to model hypothetical future needs.

export type ProgramStatus = "active" | "paused" | "closed";

export interface ProgramPolicy {
  /** Free-text in-scope targets/domains, as published by the program. */
  inScope: string[];
  /** Free-text out-of-scope targets/domains, as published by the program. */
  outOfScope: string[];
  /** e.g. ["GET", "read-only browsing"] — kept as free text, not enforced HTTP verbs. */
  allowedMethods: string[];
  /** e.g. ["automated scanning", "DoS", "social engineering"] */
  forbiddenMethods: string[];
  /** Whether the program's published policy permits any automated tooling at all. */
  automationAllowed: boolean;
  /** Raw restriction notes copied from the program's policy page, for human review. */
  restrictions: string[];
}

export interface Program {
  id: string;
  name: string;
  platform: string; // e.g. "HackerOne", "Bugcrowd", "self-hosted"
  url: string;
  policy: ProgramPolicy;
  status: ProgramStatus;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

export type TaskType = "research" | "scope_check" | "validate" | "report_draft" | "submit";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "approved"
  | "rejected"
  | "completed"
  | "failed"
  | "blocked";

export type TaskPriority = "low" | "normal" | "high";

export interface Task {
  id: string;
  type: TaskType;
  /** Null for program-less discovery tasks (public search before any Program exists). */
  programId: string | null;
  target: string;
  status: TaskStatus;
  priority: TaskPriority;
  result: string | null; // JSON-serialized result payload, nullable until completed
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FindingStatus =
  | "discovered"
  | "candidate"
  | "validated"
  | "report_draft"
  | "submitted"
  | "triaged"
  | "accepted"
  | "duplicate"
  | "invalid"
  | "informative"
  | "closed";

export type BountyStatus = "not_applicable" | "pending" | "awarded" | "paid";

export interface Finding {
  id: string;
  programId: string;
  taskId: string | null;
  title: string;
  asset: string;
  summary: string;
  status: FindingStatus;
  bountyStatus: BountyStatus;
  createdAt: string;
  updatedAt: string;
}

export type ApprovalDecision = "approved" | "rejected";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Approval {
  id: string;
  taskId: string | null;
  findingId: string | null;
  status: ApprovalStatus;
  requestedAction: string; // human-readable description of what is being approved
  telegramMessageId: string | null;
  decidedByTelegramUserId: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface Report {
  id: string;
  findingId: string;
  title: string;
  program: string;
  asset: string;
  summary: string;
  impact: string;
  stepsToReproduce: string;
  evidence: string;
  expectedBehavior: string;
  observedBehavior: string;
  suggestedRemediation: string;
  references: string;
  createdAt: string;
  updatedAt: string;
}

export interface Earning {
  id: string;
  findingId: string;
  programId: string;
  bountyStatus: BountyStatus;
  amount: number | null;
  currency: string | null;
  awardedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentRunKind = "manual" | "scheduled";
export type AgentRunStatus = "running" | "completed" | "failed" | "paused";

export interface AgentRun {
  id: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  taskId: string | null;
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
}
