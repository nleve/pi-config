import { afterEach, expect, test } from "bun:test";
import webExtension from "../web";

type Result = {
	content: Array<{ text: string }>;
	details: Record<string, unknown>;
};
type Execute = (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<Result>;

const tools = new Map<string, Execute>();
webExtension({ registerTool: (tool: { name: string; execute: Execute }) => tools.set(tool.name, tool.execute) } as never);
const search = (params: Record<string, unknown>, signal?: AbortSignal) => tools.get("web_search")!("test", { query: "example", ...params }, signal);
const fetchPage = (params: Record<string, unknown>) => tools.get("fetch")!("test", { url: "https://example.com/", ...params });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function mockFetch(fn: (url: string) => Response | Promise<Response>) {
	globalThis.fetch = (async (url: URL | Request | string) => fn(String(url))) as typeof fetch;
}

test("DDG HTML keeps snippets with their result and filters ads before limiting", async () => {
	mockFetch(() => new Response(`
		<div class="result result--ad"><a class="result__a" href="//duckduckgo.com/y.js?ad=1">Ad</a></div>
		<div class="result"><a href="https://example.com/a" class="result__a">A</a></div>
		<div class='web-result result'><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb">B</a>
		<span class="result__snippet">B <b>only</b></span></div>`));
	expect((await search({ provider: "ddg", max_results: 2 })).details).toEqual({
		provider: "ddg",
		results: [
			{ url: "https://example.com/a", title: "A", snippet: "" },
			{ url: "https://example.com/b", title: "B", snippet: "B only" },
		],
	});
});

test("DDG Lite keeps missing snippets empty and drops ad redirects", async () => {
	mockFetch(url => new Response(url.includes("lite.duckduckgo.com") ? `
		<tr><td><a class="result-link" href="https://duckduckgo.com/y.js?ad=1">Ad</a></td></tr>
		<tr><td class="result-snippet">Sponsored</td></tr>
		<tr><td><a class="result-link" href="https://example.com/a">A</a></td></tr>
		<tr><td><a href="https://example.com/b" class="result-link">B</a></td></tr>
		<tr><td class="result-snippet">B only</td></tr>` : "No HTML results"));
	expect((await search({ provider: "ddg" })).details.results).toEqual([
		{ url: "https://example.com/a", title: "A", snippet: "" },
		{ url: "https://example.com/b", title: "B", snippet: "B only" },
	]);
});

test("invalid explicit providers and already-aborted searches make no requests", async () => {
	let calls = 0;
	mockFetch(() => { calls++; return new Response(); });
	await expect(search({ provider: "not-a-provider" })).rejects.toThrow("Unknown search provider");
	await expect(search({}, AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
	expect(calls).toBe(0);
});

test("forced provider does not fall back; auto can use a configured provider", async () => {
	const original = process.env.BRAVE_API_KEY;
	process.env.BRAVE_API_KEY = "fixture-key";
	try {
		const urls: string[] = [];
		mockFetch(url => {
			urls.push(url);
			return url.includes("api.search.brave.com")
				? Response.json({ web: { results: [{ title: "Fixture", url: "https://example.com/" }] } })
				: new Response("No results");
		});
		expect((await search({ provider: "ddg" })).details.results).toEqual([]);
		expect(urls.every(url => url.includes("duckduckgo.com"))).toBe(true);
		expect((await search({})).details.provider).toBe("brave");
		delete process.env.BRAVE_API_KEY;
		await expect(search({ provider: "brave" })).rejects.toThrow("not configured");
	} finally {
		if (original === undefined) delete process.env.BRAVE_API_KEY;
		else process.env.BRAVE_API_KEY = original;
	}
});

test("HTML preserves indented code, blank lines, markup entities and backticks", async () => {
	mockFetch(() => new Response("<p>Before</p><pre><code>if x &lt; 2:\n    print(1)\n\n    # ```\n</code></pre><p>After</p>", {
		headers: { "content-type": "text/html" },
	}));
	const result = await fetchPage({});
	expect(result.content[0].text).toContain("Before\n\n````\nif x < 2:\n    print(1)\n\n    # ```\n````\n\nAfter");
});

test("fetch cancels an oversized body before EOF and distinguishes body and output truncation", async () => {
	const chunk = new Uint8Array(1024 * 1024).fill(120);
	let cancelled = false;
	mockFetch(() => new Response(new ReadableStream<Uint8Array>({
		pull(controller) { controller.enqueue(chunk); },
		cancel() { cancelled = true; },
	}), { headers: { "content-type": "text/plain" } }));
	const capped = await fetchPage({ max_chars: 10 });
	expect(cancelled).toBe(true);
	expect(capped.content[0].text).toContain("body exceeded 4 MiB");
	expect(capped.details.bodyTruncated).toBe(true);
	mockFetch(() => new Response("a short response"));
	const clipped = await fetchPage({ max_chars: 5 });
	expect(clipped.details.truncated).toBe(true);
	expect(clipped.details.bodyTruncated).toBe(false);
});

test("search caps oversized responses and does not return partial results", async () => {
	let cancelled = 0;
	const chunk = new Uint8Array(1024 * 1024).fill(120);
	mockFetch(() => new Response(new ReadableStream<Uint8Array>({
		pull(controller) { controller.enqueue(chunk); },
		cancel() { cancelled++; },
	})));
	await expect(search({ provider: "ddg" })).rejects.toThrow("response exceeded");
	expect(cancelled).toBe(2);
});
