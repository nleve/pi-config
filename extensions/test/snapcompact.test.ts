import { expect, test } from "bun:test";
import snapcompact from "../compaction/index";
import { textArchiveCharBudget } from "../compaction/budget";
import { resolveImageCountBudget } from "../compaction/tuning";
import { NEWLINE_GLYPH, PRESERVE_KEY, type Archive, viewWithoutFrames } from "../compaction/vendor/snapcompact";

const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
const frame = { ...image, cols: 80, rows: 20, chars: 15 };
const text = (...lines: string[]) => lines.join(NEWLINE_GLYPH);
const source = text("¶user: oldest", "archived middle", "¶ai: newest");
const summary = "Resume prior conversation.\n\n- Some middle sections: images, not text.\n\nFILES\n===================\nreadme.md\n\nHISTORY\n===================\n";
const archive: Archive = {
	frames: [frame],
	text: source,
	textHead: "¶user: oldest",
	textTail: "¶ai: newest",
	totalChars: source.length,
	truncatedChars: 0,
};

test("text view unfolds the saved middle and regenerates the guide without image directions", () => {
	const view = viewWithoutFrames(summary, archive, 1000, true);
	expect(view.archive.textHead).toBe(source.replaceAll(NEWLINE_GLYPH, "\n"));
	expect(view.archive.frames).toHaveLength(0);
	expect(view.summary).toContain("readme.md");
	expect(view.summary).not.toContain("Some middle sections: images");
	expect(archive.frames).toHaveLength(1);
});

test("bounded text keeps both chronological ends and reports the cut", () => {
	const view = viewWithoutFrames("Custom notes.", archive, 22, true);
	expect(view.archive.textHead?.startsWith("¶user:")).toBe(true);
	expect(view.archive.textTail?.endsWith("newest")).toBe(true);
	expect(view.archive.totalChars).toBe(22);
	expect(view.archive.truncatedChars).toBe(source.length - 22);
	expect(view.summary).toContain("Custom notes.");
	expect(viewWithoutFrames(summary, archive, 0, true).archive.textTail).toBeUndefined();
	expect(textArchiveCharBudget(8000, 3990)).toBe(20);
	expect(textArchiveCharBudget(8000, 4000)).toBe(0);
});

test("text view removes reasoning continuations and unlabelled legacy tail openings", () => {
	const full = { ...archive, text: text("¶user: keep", "¶think: exclude", "exclude continuation", "¶ai: keep newest") };
	const legacy = { ...archive, text: undefined, textTail: text("exclude partial tail", "¶ai: keep newest") };
	for (const value of [full, legacy]) {
		const view = viewWithoutFrames(summary, value, 1000, false);
		expect(JSON.stringify(view.archive)).not.toContain("exclude");
		expect(JSON.stringify(view.archive)).toContain("keep newest");
	}
});

test("context hook keeps vision frames only when a slot is free, without caching across text and image views", async () => {
	type Message = { role: string; summary?: string; timestamp?: number; content?: unknown[] };
	type Hook = (event: { messages: Message[] }, ctx: unknown) => Promise<{ messages: Message[] } | undefined>;
	let context: Hook | undefined;
	snapcompact({
		on(name: string, hook: Hook) { if (name === "context") context = hook; },
		registerCommand() {},
	} as never);
	const target = { id: "gpt-6.2-sol", provider: "openai-codex", api: "openai-codex-responses", contextWindow: 500_000 };
	const entry = { id: "archive", type: "compaction", summary, details: { [PRESERVE_KEY]: archive } };
	const render = (input: string[], messages: Message[] = [], branch: unknown[] = [entry]) => context!(
		{ messages: [{ role: "compactionSummary", summary, timestamp: 1 }, ...messages] },
		{
			model: { ...target, input },
			sessionManager: { getSessionId: () => "session", getBranch: () => branch },
			getSystemPrompt: () => "",
		},
	);
	const normal = await render(["text", "image"]);
	expect(normal?.messages[0].content?.some(block => (block as typeof image).type === "image")).toBe(true);
	const budget = resolveImageCountBudget(target);
	const userImages = { role: "user", content: Array(budget).fill(image) };
	for (const fallback of [await render(["text"]), await render(["text", "image"], [userImages])]) {
		expect(fallback?.messages[0].content?.some(block => (block as typeof image).type === "image")).toBe(false);
		expect(JSON.stringify(fallback?.messages[0])).toContain("archived middle");
	}
	expect((await render(["text", "image"]))?.messages[0]).toEqual(normal?.messages[0]);
	expect(await render(["text"], [], [entry, { ...entry, id: "soft", details: {} }])).toBeUndefined();
});
