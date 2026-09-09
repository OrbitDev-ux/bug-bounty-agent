// Minimal, dependency-free HTML shell. No client-side framework, no build
// step — server-rendered strings only, per the brief's "don't introduce a
// new framework" constraint and this project's existing "small, boring,
// verifiable" style. A little vanilla CSS for readability; forms do full
// page posts (no client JS required for any action to work).

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const NAV_ITEMS: { href: string; label: string }[] = [
  { href: "/", label: "Overview" },
  { href: "/earnings", label: "Earnings" },
  { href: "/programs", label: "Programs" },
  { href: "/findings", label: "Findings" },
  { href: "/tasks", label: "Tasks" },
  { href: "/approvals", label: "Approvals" },
  { href: "/agent", label: "Agent" },
  { href: "/activity", label: "Activity" },
  { href: "/settings", label: "Settings" },
];

export function renderPage(title: string, activePath: string, bodyHtml: string, flash?: string): string {
  const nav = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" class="nav-link${item.href === activePath ? " active" : ""}">${item.label}</a>`,
  ).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Bug Bounty Agent</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: #0d1117; color: #e6edf3; }
  header { background: #161b22; border-bottom: 1px solid #30363d; padding: 0.75rem 1rem; display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; }
  header h1 { font-size: 1rem; margin: 0; color: #58a6ff; }
  nav { display: flex; gap: 0.25rem; flex-wrap: wrap; }
  .nav-link { color: #8b949e; text-decoration: none; padding: 0.35rem 0.6rem; border-radius: 6px; font-size: 0.9rem; }
  .nav-link:hover { background: #21262d; color: #e6edf3; }
  .nav-link.active { background: #1f6feb; color: white; }
  main { padding: 1.25rem; max-width: 1100px; margin: 0 auto; }
  h2 { font-size: 1.3rem; margin-top: 0; }
  table { width: 100%; border-collapse: collapse; margin: 0.75rem 0 1.5rem; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #21262d; font-size: 0.9rem; }
  th { color: #8b949e; font-weight: 600; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 0.9rem; }
  .card .label { color: #8b949e; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; }
  .card .value { font-size: 1.6rem; font-weight: 600; margin-top: 0.25rem; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .badge.ok, .badge.paid, .badge.allow, .badge.verified { background: #1a7f37; color: white; }
  .badge.degraded, .badge.pending, .badge.needs_review { background: #9a6700; color: white; }
  .badge.failed, .badge.deny, .badge.rejected, .badge.unverified { background: #8b1c1c; color: white; }
  form.inline { display: inline; }
  button, input[type=submit] { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 0.35rem 0.7rem; cursor: pointer; font-size: 0.85rem; }
  button:hover { background: #30363d; }
  button.approve { background: #1a7f37; border-color: #1a7f37; }
  button.reject { background: #8b1c1c; border-color: #8b1c1c; }
  .flash { background: #1f6feb22; border: 1px solid #1f6feb; color: #58a6ff; padding: 0.6rem 0.9rem; border-radius: 6px; margin-bottom: 1rem; }
  .muted { color: #8b949e; font-size: 0.85rem; }
  .note { font-size: 0.8rem; color: #8b949e; margin-top: 0.5rem; }
  select, input[type=text], input[type=number] { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 0.3rem 0.5rem; }
</style>
</head>
<body>
<header>
  <h1>Bug Bounty Agent</h1>
  <nav>${nav}</nav>
</header>
<main>
${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ""}
${bodyHtml}
</main>
</body>
</html>`;
}

export function card(label: string, value: string): string {
  return `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${value}</div></div>`;
}

export function badge(text: string, cssClass: string): string {
  return `<span class="badge ${cssClass}">${escapeHtml(text)}</span>`;
}
