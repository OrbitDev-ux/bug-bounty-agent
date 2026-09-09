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
  /** Free text, e.g. "60 req/min per IP" — published rate limits, if any. */
  rateLimits?: string;
  /** Free text, e.g. "must test with a program-provided test account". */
  authenticationRequirements?: string;
  /** Anything else explicitly published that doesn't fit the other fields. */
  specialRules?: string[];
}

export interface Program {
  id: string;
  name: string;
  platform: string; // e.g. "HackerOne", "Bugcrowd", "self-hosted"
  url: string;
  policy: ProgramPolicy;
  status: ProgramStatus;
  /** v0.2: when the published policy was last actually read/confirmed. Optional so v0.1 fixtures/objects remain valid. */
  policyLastVerifiedAt?: string | null;
  /** v0.2: sha256 of the policy content, to detect drift on re-verification. */
  policyHash?: string | null;
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
  /** v0.2: how many times this task has been recovered/retried after a stale-running timeout. */
  retryCount: number;
  /** v0.2: deadline set when the task enters 'running'; the scheduler recovers tasks past this. */
  timeoutAt: string | null;
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

/**
 * How a candidate finding compares to existing findings for the same
 * program. LIKELY_DUPLICATE never auto-advances to the next workflow step
 * (project brief section 14).
 */
export type DuplicateVerdict = "LIKELY_NEW" | "POSSIBLE_DUPLICATE" | "LIKELY_DUPLICATE";

/** v0.2 only ever produces SIMULATED — there is no real platform submission integration. */
export type SubmissionMode = "SIMULATED" | "LIVE";

export interface Finding {
  id: string;
  programId: string;
  taskId: string | null;
  title: string;
  asset: string;
  summary: string;
  status: FindingStatus;
  bountyStatus: BountyStatus;
  /** v0.2 candidate-finding intelligence — all null until an agent-generated candidate sets them. */
  category: string | null;
  /** 0.0-1.0, the agent's own self-assessed confidence. Never treated as ground truth. */
  confidence: number | null;
  confidenceReason: string | null;
  duplicateVerdict: DuplicateVerdict | null;
  duplicateOfFindingId: string | null;
  /** Suggested only — never auto-finalized. A program's own published severity rubric wins if present. */
  severityCandidate: string | null;
  severityReason: string | null;
  severityConfidence: number | null;
  researchSessionId: string | null;
  submissionMode: SubmissionMode | null;
  /** v0.3.1: stamped once, the first time the finding reaches 'submitted' — for time-to-bounty analytics (section 30). */
  submittedAt: string | null;
  /** v0.3.1: stamped once, the first time the finding reaches 'accepted'. */
  acceptedAt: string | null;
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
  /** v0.2: replay/staleness protection — an approval past this can no longer be decided. Null = never expires (legacy rows). */
  expiresAt: string | null;
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

/** UNVERIFIED unless an explicit verificationSource was recorded — never inferred from bountyStatus alone. */
export type VerificationStatus = "UNVERIFIED" | "VERIFIED";

export interface Earning {
  id: string;
  findingId: string;
  programId: string;
  bountyStatus: BountyStatus;
  amount: number | null;
  currency: string | null;
  awardedAt: string | null;
  paidAt: string | null;
  /** Set only when something outside this agent (a human checking the platform, etc.) confirmed the bounty. Null = UNVERIFIED. */
  verificationSource: string | null;
  verificationStatus: VerificationStatus;
  /** Optional currency conversion metadata (section 23) — a converted amount is only ever shown when all three are present. */
  exchangeRate: number | null;
  rateSource: string | null;
  rateTimestamp: string | null;
  /** v0.3.1: idempotent dedup identity for a future real platform integration (section 45). Unique when set. */
  externalSubmissionId: string | null;
  externalBountyId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CostCategory = "claude_api" | "infrastructure" | "hosting" | "tools" | "other";

export interface Cost {
  id: string;
  category: CostCategory;
  amount: number;
  currency: string;
  note: string;
  /** Provenance: 'manual' (CLI/dashboard entry) or 'auto:<origin>' (e.g. 'auto:runClaude'). */
  source: string;
  incurredAt: string;
}

export interface Goal {
  id: string;
  name: string;
  targetAmount: number;
  targetCurrency: string;
  createdAt: string;
  archivedAt: string | null;
}

export interface RevenueAuditEntry {
  id: string;
  earningId: string;
  who: string;
  what: string;
  source: "telegram" | "web_dashboard" | "cli";
  previousValue: string | null;
  newValue: string | null;
  reason: string;
  createdAt: string;
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

// --- v0.2: Scope Intelligence ---

/**
 * Three-state scope/policy verdict (project brief section 10). Uncertainty
 * never resolves to ALLOW — an unclear policy is NEEDS_HUMAN_REVIEW, an
 * explicit prohibition is DENY.
 */
export type ScopeVerdict = "ALLOW" | "DENY" | "NEEDS_HUMAN_REVIEW";

// --- v0.2: Research Agent ---

export type ResearchSessionStatus = "running" | "completed" | "failed";

export interface PageVisited {
  url: string;
  title: string;
  capturedAt: string;
}

export interface ResearchSession {
  id: string;
  /** Null for program-less discovery research (candidate program search). */
  programId: string | null;
  taskId: string | null;
  goal: string;
  status: ResearchSessionStatus;
  queries: string[];
  pagesVisited: PageVisited[];
  scopeObservations: string;
  policyObservations: string;
  summary: string;
  nextRecommendedAction: string;
  /** 0.0-1.0, the agent's own confidence in this session's findings. */
  confidence: number | null;
  candidateFindingIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type SourceType = "OFFICIAL_POLICY" | "OFFICIAL_SCOPE" | "OFFICIAL_PROGRAM" | "PUBLIC_REFERENCE";

export interface SourceEvidence {
  id: string;
  researchSessionId: string | null;
  findingId: string | null;
  sourceUrl: string;
  sourceType: SourceType;
  title: string;
  relevantExcerpt: string;
  capturedAt: string;
}

// --- v0.2: Persistent Scheduler ---

export type SchedulerStatus = "stopped" | "running" | "paused";

export interface SchedulerRunLimits {
  maxTasksPerRun: number | null;
  maxRuntimeMs: number | null;
  maxBrowserOps: number | null;
  maxRetries: number | null;
}

export interface SchedulerState extends SchedulerRunLimits {
  status: SchedulerStatus;
  currentTaskId: string | null;
  tasksRunThisRun: number;
  browserOpsThisRun: number;
  startedAt: string | null;
  updatedAt: string;
}

// --- v0.3: Telegram AI Chat ---

/** Free Chat != Agent Control (section 7): FREECHAT never sees agent context or tools. */
export type ChatMode = "FREECHAT" | "AGENT_CHAT";

export interface ChatSession {
  telegramUserId: string;
  mode: ChatMode;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  telegramUserId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

// --- v0.3: Command Router ---

/**
 * RESEARCH_ACTION (v0.3.2): unlike CONTROL_ACTION, this executes directly
 * from chat text with no confirm tap — deliberately, because program
 * candidate discovery/research is safe-by-construction (see
 * docs/program-enrollment.md "The core guarantee"): it only ever reads
 * public web pages and writes to program_candidates, which is structurally
 * isolated from Task creation and evaluateScope() — there is no code path
 * from here to a live target. That's a materially different risk profile
 * than CONTROL_AGENT_PAUSE/RESUME (which changes real scheduler state), so
 * it doesn't need the same confirm-before-executing friction.
 */
export type IntentCategory = "CHAT" | "READ_ONLY_QUERY" | "CONTROL_ACTION" | "RESEARCH_ACTION" | "APPROVAL_ACTION" | "UNSAFE_ACTION" | "UNKNOWN";

/** Fixed, enumerable capabilities the router may invoke — never freeform code execution (section 11). */
export type Capability =
  | "READ_STATUS"
  | "READ_TASKS"
  | "READ_FINDINGS"
  | "READ_EARNINGS"
  | "READ_APPROVALS"
  | "READ_PROGRAMS"
  | "CONTROL_AGENT_PAUSE"
  | "CONTROL_AGENT_RESUME"
  | "CONTROL_AGENT_START"
  | "CANDIDATE_DISCOVER"
  | "CANDIDATE_RESEARCH"
  | "DECIDE_APPROVAL";

// --- v0.3: Settings ---

export type NotificationLevel = "all" | "important" | "none";

/**
 * Global operator settings (section 12). Deliberately has NO field for
 * disabling scope checks, approvals, or policy enforcement — not a missing
 * feature, an intentional omission.
 */
/** Per-category notification toggles (section 47). Critical alerts (Safari down, repeated task failure) bypass all of these — see alerts.ts. */
export interface NotificationPreferences {
  findingAlerts: boolean;
  approvalAlerts: boolean;
  agentErrors: boolean;
  bountyAlerts: boolean;
  dailySummary: boolean;
  weeklySummary: boolean;
  goalAlerts: boolean;
}

export interface AgentSettings {
  aiModel: string;
  notificationLevel: NotificationLevel;
  dailySummaryEnabled: boolean;
  agentAutoStart: boolean;
  researchEnabled: boolean;
  notifications: NotificationPreferences;
  /** Quiet mode (section 48) — non-critical alerts suppressed until this time. Null = not quiet. */
  quietUntil: string | null;
  updatedAt: string;
}

// --- v0.3: Health Monitoring ---

// --- v0.3.2: Program Candidate Discovery / Enrollment Preparation ---

/**
 * Program-candidate lifecycle (project brief section 30). Separate from
 * ProgramStatus entirely — a candidate never becomes live-testable by
 * changing this field; only activateForResearch() (stage ===
 * 'ready_for_research') creates a real Program row. "SELECTED_PENDING_
 * ENROLLMENT" and "ENROLLMENT_PENDING" from the brief denote the same real
 * state (selected, not yet enrolled) and are modeled as one stored stage,
 * 'enrollment_pending', set the moment a human taps [Select].
 */
export type ProgramCandidateStage =
  | "discovered"
  | "researched"
  | "candidate"
  | "enrollment_pending"
  | "authorized"
  | "ready_for_research";

/** Never guessed — UNKNOWN unless a check explicitly confirmed it (section 6). */
export type ClarityLevel = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

/** "unknown" is never treated as "allowed" (section 8). */
export type AutomationPolicyStatus = "allowed" | "forbidden" | "needs_review" | "unknown";

export type PublicOrPrivate = "public" | "private" | "unknown";

export type TriState = "yes" | "no" | "unknown";

/** Structured version of the section-6 eligibility checklist. Every field defaults to "unknown" — never guessed. */
export interface EligibilityChecks {
  publicProgram: TriState;
  registrationRequired: TriState;
  ageOrEligibilityRestrictions: TriState;
  geographicRestrictions: TriState;
  accountRequired: TriState;
  termsAcceptanceRequired: TriState;
  notes: string;
}

export interface ProgramCandidateSource {
  url: string;
  sourceType: SourceType;
  title: string;
  excerpt: string;
}

export interface EnrollmentChecklistItem {
  item: string;
  done: boolean;
}

export interface ProgramCandidate {
  id: string;
  name: string;
  platform: string;
  officialUrl: string;
  policyUrl: string | null;
  /** Normalized officialUrl, used for dedup (section 25) — never shown to a human directly. */
  canonicalUrl: string;
  stage: ProgramCandidateStage;
  publicOrPrivate: PublicOrPrivate;
  automationPolicy: AutomationPolicyStatus;
  scopeSummary: string | null;
  scopeClarity: ClarityLevel;
  policySummary: string | null;
  policyClarity: ClarityLevel;
  rewardSummary: string | null;
  rewardTransparency: ClarityLevel;
  eligibility: EligibilityChecks;
  /** Free-text risk notes for the recommendation report (section 12). */
  risks: string | null;
  sources: ProgramCandidateSource[];
  researchSessionId: string | null;
  /** Decision-support only — never a claim about real success odds or revenue (section 11). */
  recommendationScore: number | null;
  recommendationReason: string | null;
  enrollmentRequirements: string | null;
  enrollmentChecklist: EnrollmentChecklistItem[];
  selectedAt: string | null;
  selectedBy: string | null;
  /** Self-reported by the human ("I have enrolled") — never inferred from any other signal (section 18). */
  authorizationConfirmedAt: string | null;
  authorizationConfirmedBy: string | null;
  cancelledAt: string | null;
  /** Set only once activateForResearch() creates the real, live-testable Program row. */
  linkedProgramId: string | null;
  policyLastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type HealthStatus = "OK" | "DEGRADED" | "FAILED";

export interface HealthCheckResult {
  component: string;
  status: HealthStatus;
  detail: string;
}

export interface HealthReport {
  overall: HealthStatus;
  checks: HealthCheckResult[];
  checkedAt: string;
}
