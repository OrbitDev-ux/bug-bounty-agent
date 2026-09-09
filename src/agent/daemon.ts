import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Persistent local runtime via macOS launchd (project brief section 26-28).
 * Linux/systemd is not implemented — this environment is macOS, and the
 * brief makes systemd support conditional ("Linux 지원이 필요하다면"), not
 * required. See docs/daemon.md for why launchd was chosen without
 * comparing alternatives beyond a brief check: it's the standard, built-in
 * mechanism on macOS, requires no extra install, and is what `docs/setup.md`
 * already assumes for "keep running across reboots".
 *
 * Each run under launchd is still a normal, bounded `runWorkerLoop()` call
 * (default limits: 20 tasks / 2h / 200 browser ops — see scheduler.ts) —
 * this file does not introduce a second, unbounded execution mode.
 * KeepAlive + ThrottleInterval makes launchd restart the process after each
 * bounded run finishes (whether it stopped because the queue emptied, a
 * limit was hit, or it crashed), with ThrottleInterval as the backoff floor
 * so a crash loop can't spin tightly (section 28).
 */

export const DAEMON_LABEL = "com.bugbountyagent.worker";

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`);
}

export interface DaemonPaths {
  projectDir: string;
  nodeBin: string;
  cliEntrypoint: string; // relative to projectDir
  logDir: string;
}

function resolveDaemonPaths(projectDir: string): DaemonPaths {
  return {
    projectDir: resolve(projectDir),
    nodeBin: process.execPath,
    cliEntrypoint: "dist/src/cli/index.js",
    logDir: join(resolve(projectDir), "data", "logs"),
  };
}

/** Minimum seconds launchd waits between restarts — the backoff floor (section 28). */
const THROTTLE_INTERVAL_SECONDS = 300;

export function generatePlist(projectDir: string, throttleIntervalSeconds = THROTTLE_INTERVAL_SECONDS): string {
  const paths = resolveDaemonPaths(projectDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${paths.nodeBin}</string>
    <string>${paths.cliEntrypoint}</string>
    <string>agent</string>
    <string>start</string>
    <string>--daemon</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${paths.projectDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${throttleIntervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>${paths.logDir}/daemon.out.log</string>
  <key>StandardErrorPath</key>
  <string>${paths.logDir}/daemon.err.log</string>
</dict>
</plist>
`;
}

export interface InstallResult {
  plistPath: string;
  label: string;
  loaded: boolean;
  error?: string;
}

/** Writes the plist and `launchctl load`s it. The caller (CLI) is the explicit user action — this never runs on its own. */
export function installDaemon(projectDir: string): InstallResult {
  const paths = resolveDaemonPaths(projectDir);
  mkdirSync(paths.logDir, { recursive: true });
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });

  const target = plistPath();
  writeFileSync(target, generatePlist(projectDir));

  const result = spawnSync("launchctl", ["load", target], { encoding: "utf8" });
  return { plistPath: target, label: DAEMON_LABEL, loaded: result.status === 0, error: result.status !== 0 ? result.stderr.trim() : undefined };
}

export interface UninstallResult {
  removed: boolean;
  error?: string;
}

export function uninstallDaemon(): UninstallResult {
  const target = plistPath();
  const unload = spawnSync("launchctl", ["unload", target], { encoding: "utf8" });
  if (existsSync(target)) unlinkSync(target);
  return { removed: true, error: unload.status !== 0 ? unload.stderr.trim() : undefined };
}

export interface DaemonStatus {
  plistInstalled: boolean;
  registeredWithLaunchd: boolean;
  pid: number | null;
}

export function getDaemonStatus(): DaemonStatus {
  const plistInstalled = existsSync(plistPath());
  const list = spawnSync("launchctl", ["list", DAEMON_LABEL], { encoding: "utf8" });
  const registeredWithLaunchd = list.status === 0;
  let pid: number | null = null;
  if (registeredWithLaunchd) {
    const match = list.stdout.match(/"PID"\s*=\s*(\d+);/);
    if (match) pid = Number(match[1]);
  }
  return { plistInstalled, registeredWithLaunchd, pid };
}
