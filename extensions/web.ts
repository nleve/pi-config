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

function decodeEntities(input: string): string {
	return input
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'");
}

function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function unwrapDdg(href: string): string {
	try {
		const url = href.startsWith("//") ? new URL(href, "https://duckduckgo.com") : new URL(href);
		const uddg = url.searchParams.get("uddg");
		if (uddg) return uddg;
		return href;
	} catch {
		return href;
	}
}

async function fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal, ms = 25000): Promise<Response> {
	const timeout = AbortSignal.timeout(ms);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	return fetch(url, { ...init, signal: combined });
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function parseDdgHtml(html: string): SearchResult[] {
	const results: SearchResult[] = [];
	const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippets: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = snippetRe.exec(html))) snippets.push(stripTags(m[1]));
	let i = 0;
	while ((m = linkRe.exec(html))) {
		results.push({
			title: stripTags(m[2]),
			url: unwrapDdg(decodeEntities(m[1])),
			snippet: snippets[i++] ?? "",
		});
	}
	return results;
}

function parseDdgLite(html: string): SearchResult[] {
	const results: SearchResult[] = [];
	const linkRe = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippetRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
	const snippets: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = snippetRe.exec(html))) snippets.push(stripTags(m[1]));
	let i = 0;
	while ((m = linkRe.exec(html))) {
		results.push({
			title: stripTags(m[2]),
			url: unwrapDdg(decodeEntities(m[1])),
			snippet: snippets[i++] ?? "",
		});
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
		if (res.ok) {
			const parsed = parseDdgHtml(await res.text()).slice(0, count);
			if (parsed.length > 0) return parsed;
		}
	} catch {
		/* fall through */
	}
	// Lite endpoint fallback.
	const res = await fetchWithTimeout(
		`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
		{ headers: { "user-agent": UA, accept: "text/html", "accept-language": "en-US,en;q=0.9" }, redirect: "follow" },
		signal,
	);
	if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
	return parseDdgLite(await res.text()).slice(0, count);
}

async function braveSearch(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const key = process.env.BRAVE_API_KEY!;
	const res = await fetchWithTimeout(
		`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
		{ headers: { accept: "application/json", "x-subscription-token": key } },
		signal,
	);
	if (!res.ok) throw new Error(`Brave returned HTTP ${res.status}`);
	const data = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
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
	if (!res.ok) throw new Error(`Tavily returned HTTP ${res.status}`);
	const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
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
	if (!res.ok) throw new Error(`Exa returned HTTP ${res.status}`);
	const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; text?: string }> };
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
	if (!res.ok) throw new Error(`SearXNG returned HTTP ${res.status}`);
	const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
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
	const chosen = provider && available.includes(provider) ? provider : (available[0] === "ddg" ? undefined : available[0]) ?? undefined;
	const implied = provider ?? chosen;
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
	const order = [implied, ...available].filter((p, i, a): p is string => !!p && a.indexOf(p) === i);
	let lastError: unknown;
	for (const name of order) {
		try {
			const results = await run(name);
			if (results.length > 0) return { provider: name, results };
		} catch (error) {
			lastError = error;
		}
	}
	if (lastError) throw lastError;
	return { provider: order[0] ?? "ddg", results: [] };
}

// ---------------------------------------------------------------------------
// HTML -> markdown (compact, dependency-free)
// ---------------------------------------------------------------------------

function htmlToMarkdown(html: string): string {
	let text = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
		.replace(/<svg[\s\S]*?<\/svg>/gi, "")
		.replace(/<head[\s\S]*?<\/head>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");

	text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body) => `\n\`\`\`\n${stripTags(body)}\n\`\`\`\n`);
	text = text.replace(
		/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
		(_m, href, label) => {
			const l = stripTags(label);
			return l && href ? `[${l}](${href.startsWith("#") ? href : href})` : l;
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
			const count = Math.min(Math.max(params.max_results ?? 8, 1), 20);
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
				Type.Number({ description: "Maximum characters to return (default 40000)" }),
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
			const raw = await res.text();
			let body: string;
			let kind: string;
			if (contentType.includes("application/json") || /^\s*[[{]/.test(raw.slice(0, 200))) {
				kind = "json";
				try {
					body = JSON.stringify(JSON.parse(raw), null, 2);
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
			const header = `# ${url.toString()}\nHTTP ${res.status} ${res.statusText} · ${kind}${truncated ? " · truncated" : ""}\n\n`;
			return {
				content: [{ type: "text", text: header + text }],
				details: { url: url.toString(), status: res.status, contentType, kind, truncated },
			};
		},
	});
}
