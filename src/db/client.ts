import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let instance: DatabaseSync | null = null;

/**
 * Opens (or reuses) the process-wide SQLite connection and applies schema.sql.
 * Idempotent: safe to call from every entrypoint (CLI, bot, MCP server, tests).
 */
export function getDb(path?: string): DatabaseSync {
  if (instance) return instance;

  const dbPath = path ?? process.env.DATABASE_PATH ?? "./data/bug-bounty-agent.sqlite";
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  const schema = readFileSync(`${__dirname}/schema.sql`, "utf8");
  db.exec(schema);

  instance = db;
  return db;
}

/** Test-only helper: forces a fresh in-memory database on next getDb() call. */
export function resetDbForTests(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
