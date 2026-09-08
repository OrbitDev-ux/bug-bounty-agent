import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the real CLI as a subprocess against a throwaway SQLite file, so these
// tests exercise the actual `bba` entrypoint (argument parsing, DB wiring,
// output formatting) rather than the underlying domain functions directly.
// Network-touching subcommands (program add --policy-url, telegram, safari)
// are intentionally excluded here — see docs/setup.md for how those were
// manually verified.

function runCli(args: string[], dbPath: string) {
  return spawnSync("npx", ["tsx", "src/cli/index.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_PATH: dbPath },
  });
}

function withTempDb(fn: (dbPath: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "bba-cli-test-"));
  const dbPath = join(dir, "test.sqlite");
  try {
    fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("program list on an empty database prints nothing and exits 0", () => {
  withTempDb((dbPath) => {
    const result = runCli(["program", "list"], dbPath);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  });
});

test("program add (manual entry) then program list shows it", () => {
  withTempDb((dbPath) => {
    const add = runCli(
      ["program", "add", "--name", "Acme Corp", "--platform", "self-hosted", "--url", "https://acme.example", "--in-scope", "acme.example,*.acme.example", "--automation-allowed"],
      dbPath,
    );
    assert.equal(add.status, 0);
    assert.match(add.stdout, /Program created:/);

    const list = runCli(["program", "list"], dbPath);
    assert.match(list.stdout, /Acme Corp/);
    assert.match(list.stdout, /automation=true/);
  });
});

test("earnings summary on an empty database prints all zeros", () => {
  withTempDb((dbPath) => {
    const result = runCli(["earnings", "summary"], dbPath);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Today:\s+\$0\.00/);
    assert.match(result.stdout, /All time:\s+\$0\.00/);
  });
});

test("agent status reports zero counts on a fresh database", () => {
  withTempDb((dbPath) => {
    const result = runCli(["agent", "status"], dbPath);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Programs: 0/);
    assert.match(result.stdout, /Findings: 0/);
  });
});

test("task cancel on a nonexistent task id exits non-zero", () => {
  withTempDb((dbPath) => {
    const result = runCli(["task", "cancel", "does-not-exist"], dbPath);
    assert.notEqual(result.status, 0);
  });
});
