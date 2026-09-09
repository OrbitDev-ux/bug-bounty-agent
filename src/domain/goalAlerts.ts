import { getDb } from "../db/client.js";
import { listGoalProgress, type GoalProgress } from "./goals.js";

const THRESHOLDS = [25, 50, 75, 100];

/** Which (goal, threshold) pairs have already fired, so each notifies exactly once (section 33). */
function alreadyNotified(goalId: string, thresholdPct: number): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM goal_alert_log WHERE goal_id = ? AND threshold_pct = ?").get(goalId, thresholdPct);
  return row !== undefined;
}

function recordNotified(goalId: string, thresholdPct: number): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO goal_alert_log (goal_id, threshold_pct, notified_at) VALUES (?, ?, ?)").run(goalId, thresholdPct, new Date().toISOString());
}

export interface NewGoalMilestone {
  progress: GoalProgress;
  thresholdPct: number;
}

/**
 * Checks every active goal's current progress against 25/50/75/100% and
 * returns any threshold newly crossed since the last check — each
 * (goal, threshold) pair fires at most once, ever (recorded in
 * goal_alert_log). Call this after anything that could move PAID revenue
 * (markPaid, the CLI's `earnings pay`, etc.); it does not send anything
 * itself — the caller (src/agent/alerts.ts) decides how/whether to notify.
 */
export function checkGoalMilestones(): NewGoalMilestone[] {
  const newMilestones: NewGoalMilestone[] = [];
  for (const progress of listGoalProgress()) {
    const percent = Math.floor(progress.progressRatio * 100);
    for (const threshold of THRESHOLDS) {
      if (percent >= threshold && !alreadyNotified(progress.goal.id, threshold)) {
        recordNotified(progress.goal.id, threshold);
        newMilestones.push({ progress, thresholdPct: threshold });
      }
    }
  }
  return newMilestones;
}
