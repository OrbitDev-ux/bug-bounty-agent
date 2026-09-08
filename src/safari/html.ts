// Minimal, dependency-free HTML -> text/link helpers for reading Safari page
// source. Not a full HTML parser — good enough for turning a bug bounty
// program page into readable text and a link list, which is all v0.1 needs.

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (match, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      return String.fromCodePoint(parseInt(code.slice(2), 16));
    }
    if (code.startsWith("#")) {
      return String.fromCodePoint(parseInt(code.slice(1), 10));
    }
    return ENTITY_MAP[code.toLowerCase()] ?? match;
  });
}

/** Strips <script>/<style>, tags, and collapses whitespace. Caps output length. */
export function htmlToText(html: string, maxLength = 20_000): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  text = decodeEntities(text);
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

  return text.length > maxLength ? text.slice(0, maxLength) + "\n... [truncated]" : text;
}

export interface ExtractedLink {
  href: string;
  text: string;
}

/** Resolves an href against a base URL; returns null for javascript:/mailto:/etc. */
function resolveHref(href: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(href, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/** Extracts <a href> links with their visible text, deduped, capped at maxLinks. */
export function extractLinks(html: string, baseUrl: string, maxLinks = 100): ExtractedLink[] {
  const linkPattern = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  const links: ExtractedLink[] = [];

  for (const match of html.matchAll(linkPattern)) {
    const rawHref = match[1] ?? "";
    const rawText = match[2] ?? "";
    const href = resolveHref(decodeEntities(rawHref), baseUrl);
    if (!href || seen.has(href)) continue;

    const text = decodeEntities(rawText.replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();

    seen.add(href);
    links.push({ href, text });
    if (links.length >= maxLinks) break;
  }

  return links;
}

export interface TextMatch {
  index: number;
  snippet: string;
}

/** Case-insensitive substring search over already-extracted page text. */
export function findTextMatches(text: string, query: string, contextChars = 80, maxMatches = 20): TextMatch[] {
  if (!query.trim()) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const matches: TextMatch[] = [];

  let fromIndex = 0;
  while (matches.length < maxMatches) {
    const idx = haystack.indexOf(needle, fromIndex);
    if (idx === -1) break;
    const start = Math.max(0, idx - contextChars);
    const end = Math.min(text.length, idx + needle.length + contextChars);
    matches.push({ index: idx, snippet: text.slice(start, end).trim() });
    fromIndex = idx + needle.length;
  }

  return matches;
}
