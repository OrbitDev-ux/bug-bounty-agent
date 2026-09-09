# Safari MCP

## How the technology choice was made

The brief asked to check the actual macOS environment before picking a
mechanism, not default to one. On this machine (macOS 26.5.2, Safari
installed, Node v26.4.0):

| Option | Checked | Result |
|---|---|---|
| AppleScript (`tell application "Safari"`) | `osascript -e '...'` reading the front tab's URL/name | **Works immediately** — Automation permission was already granted for this terminal. |
| `do JavaScript` (AppleScript executing JS in-page) | `safari.doJavaScript(...)` via JXA | **Blocked**: `Error: You must enable 'Allow JavaScript from Apple Events' in the Developer section of Safari Settings`. This is a manual, user-facing Safari preference toggle — the project explicitly forbids changing system/app settings on the user's behalf without asking, so v0.1 does **not** use this path. |
| AppleScript `source of tab` (raw HTML, no JS toggle needed) | `tell application "Safari" to get source of current tab` | **Works, no extra permission needed.** This is what `safari_page_text`/`safari_get_links` actually use. |
| Safari WebDriver (`safaridriver`) | Not attempted | Would need a separate WebDriver session/process model and doesn't obviously improve on the above for read-only browsing; deferred as unnecessary complexity for v0.1. |
| GUI scripting (System Events keystrokes) | `keystroke "[" using command down` for back-navigation | **Requires Accessibility permission**, not yet granted to this terminal — confirmed by the actual error: `osascript에서 키스트로크를 보내도록 허용되지 않습니다. (1002)`. Used only for the three optional, best-effort tools (`safari_back`, `safari_forward`, `safari_scroll`); every other tool works without it. |

Conclusion: **AppleScript**, using `source of tab` for reading content (no
extra permission) and GUI scripting only for the three optional navigation
tools (needs Accessibility permission, degrades gracefully if absent).

## Tools exposed (`src/safari/mcp-server.ts`)

| Tool | Description | Requires |
|---|---|---|
| `safari_open` | Activates Safari | Automation |
| `safari_open_url` | Opens an http(s) URL (rejects other schemes) | Automation |
| `safari_search` | Opens a DuckDuckGo HTML search results page | Automation |
| `safari_current_tab` | Returns `{url, title}` of the front tab | Automation |
| `safari_page_title` / `safari_page_url` | Convenience subsets of the above | Automation |
| `safari_page_text` | HTML source → plain text (tags/scripts/styles stripped, truncated) | Automation |
| `safari_get_links` | HTML source → `{href, text}[]`, resolved to absolute http(s) URLs, deduped, capped | Automation |
| `safari_find_text` | Case-insensitive search over the extracted page text, with snippets | Automation |
| `safari_back` / `safari_forward` | Cmd+[ / Cmd+] via System Events | Automation **+ Accessibility** |
| `safari_scroll` | Page Up/Down via System Events | Automation **+ Accessibility** |

Deliberately **not** exposed (project brief section 6): arbitrary JS
execution, form submission, credential entry, mass clicking, arbitrary
outbound requests.

## Verified behavior

Manually verified in this environment (see transcript in the session this
was built in; reproduce with the commands below):

- MCP server boots over stdio and lists all 12 tools to a real
  `@modelcontextprotocol/sdk` client.
- `safari_current_tab` / `safari_page_text` / `safari_get_links` /
  `safari_find_text` return real data reading `https://en.wikipedia.org/wiki/Bug_bounty_program`
  (a server-rendered page) — full text extraction and 8 case-insensitive
  match snippets for "HackerOne" found.
- `safari_open_url` against `https://hackerone.com/directory/programs` (a
  client-rendered SPA) returned the page's noscript fallback text only
  ("It looks like your JavaScript is disabled...") — **this is the known
  limitation of the `source`-based approach**: JS-rendered SPAs will not
  yield useful text/links this way. Prefer server-rendered pages
  (most program policy pages, security.txt, Jekyll/static sites) as
  research targets.
- `safari_back` correctly reports `{ok:false}` with a clear
  Accessibility-permission message rather than silently failing or hanging.

Reproduce the MCP-protocol-level check:

```bash
node -e '
import("@modelcontextprotocol/sdk/client/index.js").then(async ({Client}) => {
  const {StdioClientTransport} = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({command: "npx", args: ["tsx", "src/safari/mcp-server.ts"]});
  const client = new Client({name: "check", version: "0"});
  await client.connect(transport);
  console.log((await client.listTools()).tools.map(t => t.name));
  await client.close();
});'
```

## Using it from Claude

`mcp/safari.mcp.json` is the MCP config the `claude` CLI loads:

```json
{ "mcpServers": { "safari": { "command": "npx", "args": ["tsx", "src/safari/mcp-server.ts"] } } }
```

Tools then appear to Claude as `mcp__safari__safari_open_url`, etc. — see
`src/agent/researcher.ts` for the exact `--allowedTools` list used and
docs/agent.md for a verified transcript of Claude actually using it.

## v0.3.2: dedicated agent window (fixes a real incident)

Every tool above originally operated on `front window` / `current tab of
front window` — whichever Safari window happened to be frontmost at the OS
level. In practice this meant the agent's research calls landed new tabs in
**whatever window the user was actively using**, since that's normally the
frontmost one. This was caught from real usage: a live session's program
discovery calls added over 20 research tabs (hackerone.com/directory,
bounty.github.com pages, Wikipedia, DuckDuckGo searches, a local
prompt-injection test page) into the user's own browsing window, mixed in
with their actual tabs (an in-progress signup flow, OAuth device-code login
pages, a Google Doc, shopping sites).

Fixed by giving the agent its own dedicated Safari window, addressed by
AppleScript `id` (`ensureAgentWindow()` in `src/safari/controller.ts`) —
every property-based tool (`safari_open_url`, `safari_search`,
`safari_current_tab`, `safari_page_text`, `safari_get_links`,
`safari_find_text`) now targets `window id <n>`, never `front window`.
AppleScript can read/set another application's window properties without
that window being frontmost, so these operate silently in the background —
they no longer touch the user's screen at all. The window id is persisted
to `data/.safari-agent-window.txt` (gitignored) so a one-off CLI command and
the long-running Telegram bot reuse the same window instead of each
spawning a fresh one on every call.

The three GUI-scripting tools (`safari_back`/`safari_forward`/`safari_scroll`)
are the one exception: OS-level keystrokes can only reach whatever window is
frontmost, so `withAgentWindowFrontmost()` briefly raises the agent's window,
sends the keystroke, then restores whatever app was frontmost before —
disruption limited to the instant of the keystroke, not the whole session.
These three aren't in the Research Agent's actual tool set
(`SAFARI_READ_TOOLS` in `src/agent/researcher.ts`), so this path isn't
exercised by normal research/discovery calls at all.

Verified live: `openUrl()` navigated only the agent's window while two other
real Safari windows (confirmed via a direct AppleScript window/URL dump)
were provably untouched — see the session transcript. The ~20 pre-fix
research tabs were identified by URL pattern and closed with the user's
explicit permission; the user's own tabs (including two active OAuth
device-code login flows) were left alone by only matching known
research-tool URL patterns, never a blanket "close everything."

## v0.2: SSRF hardening

`safari_open_url`/`safari_search` originally only validated the URL
*scheme*. The section-40 security audit found this let a prompt-injection
attempt direct the agent to browse internal network addresses (e.g. the
cloud metadata IP `169.254.169.254`, or `localhost`) — a confused-deputy SSRF
vector. `isBlockedHost()` (`src/safari/controller.ts`) now blocks literal
loopback/private/link-local hostnames and IP ranges before any AppleScript
call is made; verified live and covered by 6 unit tests
(`test/safari-url-guard.test.ts`). This is a hostname/IP-pattern check, not
DNS resolution — it does not catch DNS-rebinding. Full writeup in
docs/security.md.
