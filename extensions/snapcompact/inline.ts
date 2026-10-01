/**
 * Inline tool-result imaging, ported from omp's `snapcompact-inline.ts`.
 *
 * Compaction only touches history that is being discarded. The larger live
 * lever is accumulated tool output — `read`/`grep`/`find` results that sit in
 * context verbatim and are never re-read in full. On Anthropic/OpenAI a frame
 * holds ~4.2–4.8 chars per billed token, so the win is modest but real once a
 * result is large; on Gemini (fixed per-image media budget) it is large.
 *
 * Off by default (`toolResults: false`), matching omp. When on, this runs in
 * the same `context` hook that re-attaches the archive, against the same
 * provider image budget, so the two never over-subscribe the request.
 *
 * Policies stolen verbatim from omp:
 *  - never image the *last* tool result (freshest output stays crisp text)
 *  - never image an error result (provider API validation)
 *  - skip results below `MIN_TOOL_RESULT_TOKENS`
 *  - render only when `frames × frameTokenEstimate ≤ textTokens × SAVINGS_MARGIN`
 *  - oldest-first, so the imaged prefix is stable for prompt caching
 *  - skip a candidate that does not fit the remaining budget (later, smaller
 *    ones may)
 */
import {
	frames as frameCount,
	renderMany,
	type ImageContent,
	type Shape,
} from "./vendor/snapcompact";

export const MIN_TOOL_RESULT_TOKENS = 3000;
export const SAVINGS_MARGIN = 0.9;

/** Same note omp prepends to an imaged tool result. */
export const TOOL_RESULT_NOTE =
	"[Tool result text: compacted PNG frame(s) immediately below; read as verbatim output except labeled source-image position markers. Matching original images follow the frames. Image delivery: deliberate harness context-saving behavior, not malfunction. NEVER re-run call or report tool issue.]";

interface BlockView {
	type?: unknown;
	text?: unknown;
}

interface ToolResultView {
	role?: unknown;
	toolCallId?: unknown;
	content?: unknown;
	isError?: unknown;
}

export interface FrameCacheEntry {
	hash: number;
	shapeKey: string;
	frames: ImageContent[];
}

export interface InlineOptions {
	enabled: boolean;
	shape: Shape;
	/** Provider image budget minus images already carried by the request. */
	budget: number;
}

export interface InlineOutcome {
	messages: unknown[];
	changed: boolean;
	imagesAdded: number;
	savedTokens: number;
	swapped: number;
}

/** FNV-1a — cheap content identity for the render cache (no crypto import). */
function hashText(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Join text blocks; stand in for embedded source images with position markers. */
function joinedToolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	const blocks: BlockView[] = Array.isArray(content) ? (content as BlockView[]) : [];
	const parts: string[] = [];
	let imageIndex = 0;
	for (const block of blocks) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else if (block.type === "image") {
			imageIndex++;
			parts.push(`[Source image ${imageIndex} was attached here in the original tool result.]`);
		}
	}
	return parts.join("\n");
}

function passesSavingsGate(frames: number, shape: Shape, textTokens: number): boolean {
	return frames * shape.frameTokenEstimate <= textTokens * SAVINGS_MARGIN;
}

async function framesFor(
	cache: Map<string, FrameCacheEntry>,
	key: string,
	text: string,
	shape: Shape,
	shapeKey: string,
): Promise<ImageContent[]> {
	const hash = hashText(text);
	const cached = cache.get(key);
	if (cached && cached.hash === hash && cached.shapeKey === shapeKey) return cached.frames;
	const frames = await renderMany(text, { shape });
	cache.set(key, { hash, shapeKey, frames });
	return frames;
}

/**
 * Replace large historical tool results with frame images. Returns a new
 * messages array only when something changed; otherwise the input reference.
 */
export async function imageToolResults(
	messages: unknown[],
	options: InlineOptions,
	cache: Map<string, FrameCacheEntry>,
): Promise<InlineOutcome> {
	if (!options.enabled) {
		cache.clear();
		return { messages, changed: false, imagesAdded: 0, savedTokens: 0, swapped: 0 };
	}

	const shapeKey = JSON.stringify(options.shape);
	const indices: number[] = [];
	const live = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i] as ToolResultView;
		if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
		indices.push(i);
		live.add(message.toolCallId);
	}
	// Cache only for tool calls still present in context.
	for (const key of cache.keys()) {
		if (!live.has(key)) cache.delete(key);
	}
	if (options.budget <= 0 || indices.length <= 1) {
		return { messages, changed: false, imagesAdded: 0, savedTokens: 0, swapped: 0 };
	}

	let budget = options.budget;
	let changed = false;
	let imagesAdded = 0;
	let savedTokens = 0;
	let swapped = 0;
	const next = messages.slice();

	// Oldest first, but never the last tool result (freshest stays crisp).
	for (let k = 0; k < indices.length - 1 && budget > 0; k++) {
		const index = indices[k];
		const message = next[index] as ToolResultView;
		if (message.isError === true) continue;
		const text = joinedToolResultText(message.content);
		if (!text) continue;
		const textTokens = estimateTextTokens(text);
		if (textTokens < MIN_TOOL_RESULT_TOKENS) continue;
		const count = frameCount(text, { shape: options.shape });
		if (count === 0 || count > budget) continue;
		if (!passesSavingsGate(count, options.shape, textTokens)) continue;

		const frames = await framesFor(cache, message.toolCallId as string, text, options.shape, shapeKey);
		if (frames.length === 0 || frames.length > budget) continue;

		const content: unknown[] = [{ type: "text", text: TOOL_RESULT_NOTE }, ...frames];
		// Preserve any images the tool itself returned, after their markers.
		let sourceIndex = 0;
		const original = Array.isArray(message.content) ? (message.content as BlockView[]) : [];
		for (const block of original) {
			if (block.type !== "image") continue;
			sourceIndex++;
			content.push({
				type: "text",
				text: `[Original source image ${sourceIndex}; corresponds to its marker in the compacted text.]`,
			});
			content.push(block);
		}
		next[index] = { ...(message as object), content };
		budget -= frames.length;
		imagesAdded += frames.length;
		savedTokens += Math.max(0, textTokens - frames.length * options.shape.frameTokenEstimate);
		swapped++;
		changed = true;
	}

	return { messages: changed ? next : messages, changed, imagesAdded, savedTokens, swapped };
}
