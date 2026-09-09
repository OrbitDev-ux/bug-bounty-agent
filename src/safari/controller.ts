import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { htmlToText, extractLinks, findTextMatches, type ExtractedLink, type TextMatch } from "./html.js";
import { env } from "../config/env.js";

/**
 * Local Safari bridge, chosen after checking the actual macOS environment
 * (see docs/safari-mcp.md): AppleScript's `source of tab` reads full page
 * HTML without requiring "Allow JavaScript from Apple Events" — a Safari
 * developer setting this project will not flip on the user's behalf. GUI
 * scripting (System Events) is used only for back/forward/scroll, which is
 * best-effort and requires Accessibility permission for the terminal/osascript.
 *
 * Deliberately excluded from v0.1: arbitrary JS execution, form submission,
 * credential entry, and mass clicking (see project brief section 6).
 *
 * Dedicated agent window (v0.3.2): every read/navigate operation below
 * targets a Safari window created and owned by the agent, addressed by its
 * AppleScript `id` — never "front window". This means the agent never reads,
 * navigates, or overwrites whatever tab/window the human happens to be using
 * at the time; it operates in its own window regardless of what's frontmost.
 * The window id is persisted to a small file next to the database so a
 * one-off CLI command and the long-running Telegram bot both reuse the same
 * window instead of each spawning a fresh one.
 */

function runAppleScript(script: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("osascript", ["-", ...args]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `osascript exited with code ${code}`));
    });
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

/**
 * Blocks literal loopback/private/link-local hosts, including the common
 * cloud metadata address (169.254.169.254). This is a defense-in-depth
 * measure against a prompt-injection attempt to direct the agent to browse
 * internal network resources (security audit section 40 — SSRF). It's a
 * literal hostname/IP-pattern check, not DNS resolution, so it does not
 * catch DNS-rebinding (a public hostname that resolves to a private IP at
 * request time) — that would need a resolve-then-check at the network layer,
 * which AppleScript-driven Safari doesn't give us a hook for. Documented as
 * a known limitation in docs/security.md.
 */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "::") return true;
  if (/^127\./.test(h)) return true; // 127.0.0.0/8
  if (/^10\./.test(h)) return true; // 10.0.0.0/8
  if (/^192\.168\./.test(h)) return true; // 192.168.0.0/16
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true; // 172.16.0.0/12
  if (/^169\.254\./.test(h)) return true; // 169.254.0.0/16 (includes cloud metadata 169.254.169.254)
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 link-local
  return false;
}

/** Throws if `url` is not http(s), or resolves to a loopback/private/link-local host. */
export function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Refusing to open non-http(s) URL scheme: ${parsed.protocol}`);
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error(`Refusing to open a loopback/private/link-local host: ${parsed.hostname}`);
  }
}

const AGENT_WINDOW_STATE_PATH = `${dirname(env.databasePath)}/.safari-agent-window.txt`;

/** In-process cache — avoids a file read on every single call within one long-running process (the Telegram bot). */
let cachedAgentWindowId: number | null = null;

function loadPersistedWindowId(): number | null {
  try {
    const raw = readFileSync(AGENT_WINDOW_STATE_PATH, "utf8").trim();
    const id = Number(raw);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

function persistWindowId(id: number): void {
  try {
    mkdirSync(dirname(AGENT_WINDOW_STATE_PATH), { recursive: true });
    writeFileSync(AGENT_WINDOW_STATE_PATH, String(id), "utf8");
  } catch {
    // Best-effort only — a failed write just means the next process creates a fresh window instead of reusing this one.
  }
}

async function windowExists(id: number): Promise<boolean> {
  try {
    const out = await runAppleScript(
      `on run argv
         set theId to (item 1 of argv) as integer
         tell application "Safari"
           repeat with w in windows
             if id of w is theId then return "yes"
           end repeat
         end tell
         return "no"
       end run`,
      [String(id)],
    );
    return out.trim() === "yes";
  } catch {
    return false;
  }
}

/**
 * Returns the id of the agent's own dedicated Safari window, creating one if
 * it doesn't exist yet (fresh process) or was closed (user closed it).
 * Creating a new window does briefly take window focus at the OS level —
 * unavoidable, since Safari always opens a new window in front — but it
 * never reads, navigates, or modifies any window/tab the human already had
 * open, and best-effort restores whatever app was frontmost immediately
 * before, so it doesn't leave the human's attention sitting on Safari.
 */
async function ensureAgentWindow(): Promise<number> {
  if (cachedAgentWindowId !== null && (await windowExists(cachedAgentWindowId))) return cachedAgentWindowId;

  const persisted = loadPersistedWindowId();
  if (persisted !== null && (await windowExists(persisted))) {
    cachedAgentWindowId = persisted;
    return persisted;
  }

  let previousFrontApp: string | null = null;
  try {
    previousFrontApp = (
      await runAppleScript(`tell application "System Events" to get name of first application process whose frontmost is true`)
    ).trim();
  } catch {
    previousFrontApp = null; // best-effort — Accessibility permission may not be granted
  }

  const newIdOut = await runAppleScript(`tell application "Safari"
    make new document with properties {URL:"about:blank"}
    delay 0.3
    return id of window 1
  end tell`);
  const newId = Number(newIdOut.trim());

  if (previousFrontApp) {
    try {
      await runAppleScript(`on run argv\n  tell application (item 1 of argv) to activate\nend run`, [previousFrontApp]);
    } catch {
      // best-effort only
    }
  }

  cachedAgentWindowId = newId;
  persistWindowId(newId);
  return newId;
}

export async function open(): Promise<void> {
  await ensureAgentWindow();
}

export async function openUrl(url: string, newTab = true): Promise<{ url: string; title: string }> {
  assertHttpUrl(url);
  const windowId = await ensureAgentWindow();
  const script = newTab
    ? `on run argv
         set theURL to item 1 of argv
         set theId to (item 2 of argv) as integer
         tell application "Safari"
           tell window id theId to set current tab to (make new tab with properties {URL:theURL})
           delay 0.8
           set theTab to current tab of window id theId
           return (URL of theTab) & "|||" & (name of theTab)
         end tell
       end run`
    : `on run argv
         set theURL to item 1 of argv
         set theId to (item 2 of argv) as integer
         tell application "Safari"
           set URL of current tab of window id theId to theURL
           delay 0.8
           set theTab to current tab of window id theId
           return (URL of theTab) & "|||" & (name of theTab)
         end tell
       end run`;
  const out = await runAppleScript(script, [url, String(windowId)]);
  const [resultUrl, title] = out.split("|||");
  return { url: resultUrl ?? url, title: title ?? "" };
}

const SEARCH_ENGINES = {
  duckduckgo: (q: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
} as const;

export async function search(query: string, engine: keyof typeof SEARCH_ENGINES = "duckduckgo") {
  const url = SEARCH_ENGINES[engine](query);
  return openUrl(url, true);
}

export async function currentTab(): Promise<{ url: string; title: string }> {
  const windowId = await ensureAgentWindow();
  const script = `on run argv
    set theId to (item 1 of argv) as integer
    tell application "Safari"
      set theTab to current tab of window id theId
      return (URL of theTab) & "|||" & (name of theTab)
    end tell
  end run`;
  const out = await runAppleScript(script, [String(windowId)]);
  const [url, title] = out.split("|||");
  return { url: url ?? "", title: title ?? "" };
}

export async function pageTitle(): Promise<string> {
  return (await currentTab()).title;
}

export async function pageUrl(): Promise<string> {
  return (await currentTab()).url;
}

async function currentTabSource(): Promise<{ url: string; source: string }> {
  const windowId = await ensureAgentWindow();
  const script = `on run argv
    set theId to (item 1 of argv) as integer
    tell application "Safari"
      set theTab to current tab of window id theId
      return (URL of theTab) & "|||" & (source of theTab)
    end tell
  end run`;
  const out = await runAppleScript(script, [String(windowId)]);
  const sepIndex = out.indexOf("|||");
  return { url: out.slice(0, sepIndex), source: out.slice(sepIndex + 3) };
}

export async function pageText(maxLength = 20_000): Promise<string> {
  const { source } = await currentTabSource();
  return htmlToText(source, maxLength);
}

export async function getLinks(maxLinks = 100): Promise<ExtractedLink[]> {
  const { url, source } = await currentTabSource();
  return extractLinks(source, url, maxLinks);
}

export async function findText(query: string): Promise<TextMatch[]> {
  const { source } = await currentTabSource();
  return findTextMatches(htmlToText(source, 200_000), query);
}

export interface GuiActionResult {
  ok: boolean;
  note: string;
}

/**
 * GUI scripting (System Events keystrokes) can only target whatever window
 * is frontmost at the OS level — unlike the AppleScript-property calls
 * above, there's no way to send a keystroke to a specific background
 * window. So for these three tools only, the agent window is briefly
 * raised to front immediately before the keystroke, then whatever the user
 * had frontmost before is restored immediately after — the disruption is
 * limited to the instant of the keystroke itself, not the browsing session.
 */
async function withAgentWindowFrontmost<T>(action: () => Promise<T>): Promise<T> {
  const windowId = await ensureAgentWindow();

  let previousFrontApp: string | null = null;
  try {
    previousFrontApp = (
      await runAppleScript(`tell application "System Events" to get name of first application process whose frontmost is true`)
    ).trim();
  } catch {
    previousFrontApp = null;
  }

  await runAppleScript(
    `on run argv
       set theId to (item 1 of argv) as integer
       tell application "Safari"
         activate
         set index of window id theId to 1
       end tell
     end run`,
    [String(windowId)],
  );

  try {
    return await action();
  } finally {
    if (previousFrontApp) {
      try {
        await runAppleScript(`on run argv\n  tell application (item 1 of argv) to activate\nend run`, [previousFrontApp]);
      } catch {
        // best-effort only
      }
    }
  }
}

/** Best-effort: requires Accessibility permission for the process running osascript. */
async function guiKeystroke(char: string): Promise<GuiActionResult> {
  const script = `on run argv
    set theChar to item 1 of argv
    tell application "System Events"
      tell process "Safari"
        keystroke theChar using command down
      end tell
    end tell
  end run`;
  try {
    await withAgentWindowFrontmost(() => runAppleScript(script, [char]));
    return { ok: true, note: "sent" };
  } catch (err) {
    return { ok: false, note: `GUI scripting failed (Accessibility permission likely needed): ${(err as Error).message}` };
  }
}

export async function back(): Promise<GuiActionResult> {
  return guiKeystroke("[");
}

export async function forward(): Promise<GuiActionResult> {
  return guiKeystroke("]");
}

export async function scroll(direction: "down" | "up" = "down"): Promise<GuiActionResult> {
  const keyCode = direction === "down" ? 121 : 116; // Page Down / Page Up
  const script = `on run argv
    set theCode to (item 1 of argv) as integer
    tell application "System Events" to key code theCode
  end run`;
  try {
    await withAgentWindowFrontmost(() => runAppleScript(script, [String(keyCode)]));
    return { ok: true, note: "sent" };
  } catch (err) {
    return { ok: false, note: `GUI scripting failed (Accessibility permission likely needed): ${(err as Error).message}` };
  }
}
