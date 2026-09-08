#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as safari from "./controller.js";

/**
 * Safari MCP server (v0.1). Exposes only read-only browsing + navigation
 * tools over stdio, per project brief section 6 — no arbitrary JS execution,
 * form submission, credential entry, or mass clicking. Meant to be launched
 * by `claude --mcp-config` (see mcp/safari.mcp.json), not run standalone.
 */

const server = new McpServer({ name: "safari-mcp", version: "0.1.0" });

server.registerTool(
  "safari_open",
  { title: "Open Safari", description: "Activates/brings Safari to the foreground. No navigation." },
  async () => {
    await safari.open();
    return { content: [{ type: "text", text: "Safari opened." }] };
  },
);

server.registerTool(
  "safari_open_url",
  {
    title: "Open URL",
    description: "Opens an http(s) URL in Safari (new tab by default). Refuses non-http(s) schemes.",
    inputSchema: { url: z.string().url(), newTab: z.boolean().optional() },
  },
  async ({ url, newTab }) => {
    const result = await safari.openUrl(url, newTab ?? true);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  "safari_search",
  {
    title: "Web search",
    description: "Opens a public web search (DuckDuckGo HTML results) for the given query in Safari.",
    inputSchema: { query: z.string().min(1) },
  },
  async ({ query }) => {
    const result = await safari.search(query);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  "safari_current_tab",
  { title: "Current tab", description: "Returns the URL and title of the front Safari tab." },
  async () => {
    const result = await safari.currentTab();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  "safari_page_title",
  { title: "Page title", description: "Returns the title of the current Safari tab." },
  async () => {
    return { content: [{ type: "text", text: await safari.pageTitle() }] };
  },
);

server.registerTool(
  "safari_page_url",
  { title: "Page URL", description: "Returns the URL of the current Safari tab." },
  async () => {
    return { content: [{ type: "text", text: await safari.pageUrl() }] };
  },
);

server.registerTool(
  "safari_page_text",
  {
    title: "Page text",
    description:
      "Returns the visible text of the current Safari tab (HTML stripped, truncated). Note: JS-rendered single-page apps may return little or no text — this reads static HTML source, not the rendered DOM.",
    inputSchema: { maxLength: z.number().int().positive().max(100_000).optional() },
  },
  async ({ maxLength }) => {
    const text = await safari.pageText(maxLength ?? 20_000);
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "safari_get_links",
  {
    title: "Get links",
    description: "Extracts http(s) links (href + visible text) from the current Safari tab's HTML source.",
    inputSchema: { maxLinks: z.number().int().positive().max(500).optional() },
  },
  async ({ maxLinks }) => {
    const links = await safari.getLinks(maxLinks ?? 100);
    return { content: [{ type: "text", text: JSON.stringify(links) }] };
  },
);

server.registerTool(
  "safari_back",
  {
    title: "Go back",
    description: "Best-effort: navigates back via Cmd+[ (requires Accessibility permission for osascript/Terminal).",
  },
  async () => {
    const result = await safari.back();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  "safari_forward",
  {
    title: "Go forward",
    description: "Best-effort: navigates forward via Cmd+] (requires Accessibility permission for osascript/Terminal).",
  },
  async () => {
    const result = await safari.forward();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  "safari_scroll",
  {
    title: "Scroll page",
    description: "Best-effort: scrolls the page up or down one page (requires Accessibility permission).",
    inputSchema: { direction: z.enum(["down", "up"]).optional() },
  },
  async ({ direction }) => {
    const result = await safari.scroll(direction ?? "down");
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  "safari_find_text",
  {
    title: "Find text on page",
    description: "Searches the current tab's extracted text for a query and returns matching snippets with context.",
    inputSchema: { query: z.string().min(1) },
  },
  async ({ query }) => {
    const matches = await safari.findText(query);
    return { content: [{ type: "text", text: JSON.stringify(matches) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
