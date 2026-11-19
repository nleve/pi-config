/**
 * Web tools for Pi: `web_search` and `fetch`.
 *
 * `web_search` works with no API key (DuckDuckGo HTML), and upgrades to
 * Brave / Tavily / Exa / SearXNG when a key or URL is present in the env:
 *   BRAVE_API_KEY, TAVILY_API_KEY, EXA_API_KEY, SEARXNG_URL (+ optional SEARXNG_API_KEY)
 *
 * `fetch` retrieves a URL and converts HTML to readable markdown, pretty-prints
 * JSON, and passes text through. It does not run JavaScript; use the agent-browser
 * MCP tools (via tool_search) for client-rendered pages.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

const NAMED_ENTITIES: Record<string, string> = {
	nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
};

function decodeEntities(input: string): string {
	return input.replace(/&(?:#(x[0-9a-f]+|\d+)|([a-z]+));/gi, (entity, numeric, name) => {
		if (!numeric) return Object.hasOwn(NAMED_ENTITIES, name.toLowerCase()) ? NAMED_ENTITIES[name.toLowerCase()] : entity;
		const hex = /^x/i.test(numeric);
		const cp = Number.parseInt(hex ? numeric.slice(1) : numeric, hex ? 16 : 10);
		return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "\uFFFD";
	});
}

function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

// Based on OMP's DDG URL handling (ad4744d694): ads must not consume
// organic result slots. Only unwrap redirects that actually belong to DDG.
function unwrapDdg(href: string): string | undefined {
	try {
		const url = new URL(href.startsWith("//") ? `https:${href}` : href);
		const isDdg = /^(?:www\.)?duckduckgo\.com$/i.test(url.hostname);
		if (isDdg && url.pathname === "/y.js") return;
		const target = isDdg && /^\/l\/?$/.test(url.pathname) ? url.searchParams.get("uddg") : null;
		const result = target ? new URL(target) : url;
		if (/^(?:www\.)?duckduckgo\.com$/i.test(result.hostname) && result.pathname === "/y.js") return;
		if (result.protocol === "http:" || result.protocol === "https:") return result.href;
	} catch {
		// Ignore invalid targets rather than recommending them to fetch.
	}
}

const FETCH_MAX_BYTES = 4 * 1024 * 1024;
const SEARCH_MAX_BYTES = 2 * 1024 * 1024;

// Adapted from OMP's readBoundedBody. Cap actual decoded bytes, not the
// Content-Length header (which may be absent or describe compressed bytes).
async function readBoundedBody(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	const reader = res.body?.getReader();
	if (!reader) return { bytes: new Uint8Array(), truncated: false };

	let buffer = new Uint8Array(Math.min(maxBytes, 64 * 1024));
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return { bytes: buffer.subarray(0, size), truncated: false };
			const accepted = Math.min(value.byteLength, maxBytes - size);
			if (size + accepted > buffer.length) {
				const next = new Uint8Array(Math.min(maxBytes, Math.max(size + accepted, buffer.length * 2)));
				next.set(buffer.subarray(0, size));
				buffer = next;
			}
			buffer.set(value.subarray(0, accepted), size);
			size += accepted;
			if (accepted < value.byteLength) {
				void reader.cancel().catch(() => {});
				return { bytes: buffer.subarray(0, size), truncated: true };
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function decodeBody(bytes: Uint8Array, contentType = ""): string {
	let charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
	if (!charset && (!contentType || /html/i.test(contentType))) {
		const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
		charset = /<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
	}
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder().decode(bytes);
	}
}

async function readSearchBody(res: Response, label: string): Promise<string> {
	if (!res.ok) {
		void res.body?.cancel().catch(() => {});
		throw new Error(`${label} returned HTTP ${res.status}`);
	}
	const { bytes, truncated } = await readBoundedBody(res, SEARCH_MAX_BYTES);
	if (truncated) throw new Error(`${label} response exceeded ${SEARCH_MAX_BYTES} bytes`);
	return decodeBody(bytes, res.headers.get("content-type") ?? "");
}

async function fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal, ms = 25000): Promise<Response> {
	const timeout = AbortSignal.timeout(ms);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	return fetch(url, { ...init, signal: combined });
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

// Match titles independently of href/class attribute order.
const DDG_HTML_LINK = /<a\b(?=[^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'])(?=[^>]*\bhref=(?:"([^"]+)"|'([^']+)'))[^>]*>([\s\S]*?)<\/a>/i;
const DDG_LITE_LINK = /<a\b(?=[^>]*\bclass=["'][^"']*\bresult-link\b[^"']*["'])(?=[^>]*\bhref=(?:"([^"]+)"|'([^']+)'))[^>]*>([\s\S]*?)<\/a>/gi;

function ddgResult(link: RegExpMatchArray, snippet?: string): SearchResult | undefined {
	const url = unwrapDdg(decodeEntities(link[1] ?? link[2]));
	const title = stripTags(link[3]);
	if (url && title) return { title, url, snippet: snippet ? stripTags(snippet) : "" };
}

function parseDdgHtml(html: string): SearchResult[] {
	// Ported from OMP: pair optional previews with titles inside each
	// result container, never by zipping two independent match lists.
	const rows = /<div\b[^>]*\bclass=(?:"(?:[^"]*\s)?result(?:\s[^"]*)?"|'(?:[^']*\s)?result(?:\s[^']*)?')[^>]*>/gi;
	const results: SearchResult[] = [];
	for (const row of html.split(rows).slice(1)) {
		const link = DDG_HTML_LINK.exec(row);
		if (!link) continue;
		const snippet = /<(a|div|span)\b[^>]*\bclass=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i.exec(row);
		const result = ddgResult(link, snippet?.[2]);
		if (result) results.push(result);
	}
	return results;
}

function parseDdgLite(html: string): SearchResult[] {
	const links = [...html.matchAll(DDG_LITE_LINK)];
	const results: SearchResult[] = [];
	for (const [i, link] of links.entries()) {
		const after = (link.index ?? 0) + link[0].length;
		const row = html.slice(after, links[i + 1]?.index);
		const snippet = /<td\b[^>]*\bclass=["'][^"']*\bresult-snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i.exec(row);
		const result = ddgResult(link, snippet?.[1]);
		if (result) results.push(result);
	}
	return results;
}

async function ddgSearch(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
	// Modern HTML endpoint first.
	try {
		const res = await fetchWithTimeout(
			"https://html.duckduckgo.com/html/",
			{
				method: "POST",
				headers: {
					"user-agent": UA,
					"content-type": "application/x-www-form-urlencoded",
					accept: "text/html",
					"accept-language": "en-US,en;q=0.9",
				},
				body: new URLSearchParams({ q: query, kl: "us-en" }).toString(),
				redirect: "follow",
			},
			signal,
		);
		const parsed = parseDdgHtml(await readSearchBody(res, "DuckDuckGo")).slice(0, count);
		if (parsed.length > 0) return parsed;
	} catch {
		signal?.throwIfAborted();
		// Try Lite if the HTML frontend failed.
	}
	// Lite endpoint fallback.
	const res = await fetchWithTimeout(
		`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
		{ headers: { "user-agent": UA, accept: "text/html", "accept-language": "en-US,en;q=0.9" }, redirect: "follow" },
		signal,
	);
	return parseDdgLite(await readSearchBody(res, "DuckDuckGo Lite")).slice(0, count);
}

async function braveSearch(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const key = process.env.BRAVE_API_KEY!;
	const res = await fetchWithTimeout(
		`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
		{ headers: { accept: "application/json", "x-subscription-token": key } },
		signal,
	);
	const data = JSON.parse(await readSearchBody(res, "Brave")) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
	return (data.web?.results ?? []).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: stripTags(r.description ?? ""),
	}));
}

async function tavilySearch(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const key = process.env.TAVILY_API_KEY!;
	const res = await fetchWithTimeout(
		"https://api.tavily.com/search",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ api_key: key, query, max_results: count, include_answer: false }),
		},
		signal,
	);
	const data = JSON.parse(await readSearchBody(res, "Tavily")) as { results?: Array<{ title?: string; url?: string; content?: string }> };
	return (data.results ?? []).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: (r.content ?? "").trim(),
	}));
}

async function exaSearch(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const key = process.env.EXA_API_KEY!;
	const res = await fetchWithTimeout(
		"https://api.exa.ai/search",
		{
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": key },
			body: JSON.stringify({ query, numResults: count, contents: { text: { maxCharacters: 500 } } }),
		},
		signal,
	);
	const data = JSON.parse(await readSearchBody(res, "Exa")) as { results?: Array<{ title?: string; url?: string; text?: string }> };
	return (data.results ?? []).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: (r.text ?? "").replace(/\s+/g, " ").trim(),
	}));
}

async function searxngSearch(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const base = process.env.SEARXNG_URL!.replace(/\/$/, "");
	const headers: Record<string, string> = { accept: "application/json" };
	if (process.env.SEARXNG_API_KEY) headers.authorization = `Bearer ${process.env.SEARXNG_API_KEY}`;
	const res = await fetchWithTimeout(
		`${base}/search?q=${encodeURIComponent(query)}&format=json`,
		{ headers },
		signal,
	);
	const data = JSON.parse(await readSearchBody(res, "SearXNG")) as { results?: Array<{ title?: string; url?: string; content?: string }> };
	return (data.results ?? []).slice(0, count).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: (r.content ?? "").trim(),
	}));
}

function availableProviders(): string[] {
	const providers = ["ddg"];
	if (process.env.BRAVE_API_KEY) providers.push("brave");
	if (process.env.TAVILY_API_KEY) providers.push("tavily");
	if (process.env.EXA_API_KEY) providers.push("exa");
	if (process.env.SEARXNG_URL) providers.push("searxng");
	return providers;
}

async function runSearch(
	query: string,
	count: number,
	provider: string | undefined,
	signal?: AbortSignal,
): Promise<{ provider: string; results: SearchResult[] }> {
	const available = availableProviders();
	if (provider !== undefined && !["ddg", "brave", "tavily", "exa", "searxng"].includes(provider)) {
		throw new Error(`Unknown search provider "${provider}". Choose ddg, brave, tavily, exa, or searxng.`);
	}
	if (provider !== undefined && !available.includes(provider)) {
		throw new Error(`Search provider "${provider}" is not configured. Available: ${available.join(", ")}.`);
	}
	const run = (name: string): Promise<SearchResult[]> => {
		switch (name) {
			case "brave":
				return braveSearch(query, count, signal);
			case "tavily":
				return tavilySearch(query, count, signal);
			case "exa":
				return exaSearch(query, count, signal);
			case "searxng":
				return searxngSearch(query, count, signal);
			default:
				return ddgSearch(query, count, signal);
		}
	};
	const order = provider !== undefined ? [provider] : available;
	let lastError: unknown;
	let firstEmpty: string | undefined;
	for (const name of order) {
		signal?.throwIfAborted();
		try {
			const results = (await run(name)).slice(0, count);
			if (results.length > 0) return { provider: name, results };
			firstEmpty ??= name;
		} catch (error) {
			signal?.throwIfAborted();
			lastError = error;
		}
	}
	if (firstEmpty) return { provider: firstEmpty, results: [] };
	throw lastError;
}

// ---------------------------------------------------------------------------
// HTML -> markdown (compact, dependency-free)
// ---------------------------------------------------------------------------

function htmlToMarkdown(html: string): string {
	const clean = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
		.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "")
		.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");
	const parts: string[] = [];
	let start = 0;
	for (const match of clean.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)) {
		const index = match.index ?? 0;
		parts.push(proseToMarkdown(clean.slice(start, index)));
		const code = decodeEntities(match[1].replace(/<[^>]+>/g, "")).replace(/\r\n?/g, "\n");
		let fenceLength = 3;
		for (const run of code.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, run[0].length + 1);
		const fence = "`".repeat(fenceLength);
		parts.push(fence + "\n" + code + (code.endsWith("\n") ? "" : "\n") + fence);
		start = index + match[0].length;
	}
	parts.push(proseToMarkdown(clean.slice(start)));
	return parts.filter(Boolean).join("\n\n");
}

function proseToMarkdown(html: string): string {
	let text = html;
	text = text.replace(
		/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
		(_m, href, label) => {
			const l = stripTags(label);
			return l && href ? `[${l}](${href})` : l;
		},
	);
	text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, body) => `\n${"#".repeat(Number(level))} ${stripTags(body)}\n`);
	text = text.replace(/<li[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "");
	text = text.replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote)>/gi, "\n\n");
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<[^>]+>/g, "");
	text = decodeEntities(text);
	text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: text.slice(0, maxChars) + `\n\n… [truncated at ${maxChars} chars]`, truncated: true };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function webExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web and return ranked results (title, url, snippet). Uses DuckDuckGo by default and needs no API key; uses Brave/Tavily/Exa/SearXNG when configured via environment variables.",
		promptSnippet: "Search the web for pages matching a query",
		promptGuidelines: [
			"Use web_search when you need current information, documentation, or sources beyond the local repository.",
			"Follow up with fetch on the most promising result URLs to read them.",
		],
		annotations: { readOnlyHint: true, openWorldHint: true },
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			max_results: Type.Optional(
				Type.Number({ description: "Maximum number of results to return (default 8, max 20)" }),
			),
			provider: Type.Optional(
				Type.String({ description: "Force a provider: ddg, brave, tavily, exa, or searxng" }),
			),
		}),
		async execute(_id, params, signal) {
			const count = Math.min(Math.max(Math.floor(params.max_results ?? 8), 1), 20);
			const { provider, results } = await runSearch(params.query, count, params.provider, signal);
			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No results for "${params.query}" (via ${provider}).` }],
					details: { provider, results: [] },
				};
			}
			const text = results
				.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
				.join("\n\n");
			return {
				content: [{ type: "text", text: `Results via ${provider}:\n\n${text}` }],
				details: { provider, results },
			};
		},
	});

	pi.registerTool({
		name: "fetch",
		label: "Fetch URL",
		description:
			"Fetch a URL over HTTP and return readable content: HTML is converted to markdown, JSON is pretty-printed, text is returned as-is. Does not execute JavaScript.",
		promptSnippet: "Fetch a URL and return its readable content",
		promptGuidelines: [
			"Use fetch to read a specific URL returned by web_search or given by the user.",
			"For pages that require JavaScript or a logged-in session, find and use the agent-browser tools with tool_search instead.",
		],
		annotations: { readOnlyHint: true, openWorldHint: true },
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http(s) URL to fetch" }),
			max_chars: Type.Optional(
				Type.Integer({ minimum: 1, description: "Maximum characters to return (default 40000)" }),
			),
		}),
		async execute(_id, params, signal) {
			let url: URL;
			try {
				url = new URL(params.url);
			} catch {
				throw new Error(`Invalid URL: ${params.url}`);
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				throw new Error(`Unsupported protocol: ${url.protocol}`);
			}
			const res = await fetchWithTimeout(
				url.toString(),
				{
					headers: {
						"user-agent": UA,
						accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
						"accept-language": "en-US,en;q=0.9",
					},
					redirect: "follow",
				},
				signal,
			);
			const contentType = res.headers.get("content-type") ?? "";
			const { bytes, truncated: bodyTruncated } = await readBoundedBody(res, FETCH_MAX_BYTES);
			const raw = decodeBody(bytes, contentType);
			let body: string;
			let kind: string;
			if (contentType.includes("application/json") || /^\s*[[{]/.test(raw.slice(0, 200))) {
				kind = "json";
				try {
					body = bodyTruncated ? raw : JSON.stringify(JSON.parse(raw), null, 2);
				} catch {
					body = raw;
				}
			} else if (contentType.includes("html") || /<html[\s>]/i.test(raw.slice(0, 1000))) {
				kind = "html→markdown";
				body = htmlToMarkdown(raw);
			} else {
				kind = "text";
				body = raw;
			}
			const { text, truncated } = truncate(body, params.max_chars ?? 40000);
			const finalUrl = res.url || url.toString();
			const bodyNote = bodyTruncated ? ` · body exceeded ${FETCH_MAX_BYTES / 1024 / 1024} MiB` : "";
			const header = `# ${finalUrl}\nHTTP ${res.status} ${res.statusText} · ${kind}${truncated ? " · output truncated" : ""}${bodyNote}\n\n`;
			return {
				content: [{ type: "text", text: header + text }],
				details: { url: finalUrl, status: res.status, contentType, kind, truncated: truncated || bodyTruncated, bodyTruncated },
			};
		},
	});
}
