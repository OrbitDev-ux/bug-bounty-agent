import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, extractLinks, findTextMatches } from "../src/safari/html.js";

test("htmlToText strips tags, scripts, and styles", () => {
  const html = `<html><head><style>.x{color:red}</style></head>
    <body><script>alert(1)</script><h1>Bounty Program</h1><p>Scope: *.example.com</p></body></html>`;
  const text = htmlToText(html);
  assert.ok(!text.includes("alert"));
  assert.ok(!text.includes("color:red"));
  assert.ok(text.includes("Bounty Program"));
  assert.ok(text.includes("Scope: *.example.com"));
});

test("htmlToText decodes common entities", () => {
  const text = htmlToText("<p>Q&amp;A &mdash; caf&#233;</p>".replace("&mdash;", "&#8212;"));
  assert.ok(text.includes("Q&A"));
  assert.ok(text.includes("café"));
});

test("htmlToText truncates at maxLength", () => {
  const html = "<p>" + "a".repeat(1000) + "</p>";
  const text = htmlToText(html, 50);
  assert.ok(text.length <= 70);
  assert.ok(text.endsWith("[truncated]"));
});

test("extractLinks resolves relative hrefs and dedupes", () => {
  const html = `
    <a href="/policy">Policy</a>
    <a href="https://example.com/scope">Scope</a>
    <a href="/policy">Policy again</a>
    <a href="javascript:alert(1)">evil</a>
    <a href="mailto:security@example.com">mail</a>
  `;
  const links = extractLinks(html, "https://example.com/program");
  assert.equal(links.length, 2);
  assert.ok(links.some((l) => l.href === "https://example.com/policy"));
  assert.ok(links.some((l) => l.href === "https://example.com/scope"));
  assert.ok(!links.some((l) => l.href.startsWith("javascript:")));
});

test("extractLinks respects maxLinks cap", () => {
  const html = Array.from({ length: 10 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join("");
  const links = extractLinks(html, "https://example.com", 3);
  assert.equal(links.length, 3);
});

test("findTextMatches finds case-insensitive occurrences with context", () => {
  const text = "The scope includes *.example.com and excludes internal.example.com explicitly.";
  const matches = findTextMatches(text, "EXAMPLE.COM");
  assert.equal(matches.length, 2);
  assert.ok(matches[0]?.snippet.includes("example.com"));
});

test("findTextMatches returns empty for a blank query", () => {
  assert.deepEqual(findTextMatches("some text", "   "), []);
});
