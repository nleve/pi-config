// Minimal stand-in for the `classifyModel`/revision helpers snapcompact imports
// from @oh-my-pi/pi-catalog/identity (MIT). Only the Anthropic-family decision in
// `idealShapeVariant` consumes this: it raises Opus 4.7+, Fable, and Mythos lines
// to the high-resolution frame shape. Everything else falls through to the
// regex table inside snapcompact, so this shim only needs to be right for the
// Claude lines.
export type Revision = readonly [number, number, number];

export interface ModelIdentity {
	class: string;
	family?: string;
	revision?: string;
}

function parseComponent(value: string): number | undefined {
	if (!value) return undefined;
	let out = 0;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 48 || code > 57) return undefined;
		out = out * 10 + (code - 48);
		if (out > 255) return undefined;
	}
	return out;
}

/** Parse `major[.minor[.patch]]` (also `-` separated); undefined when malformed. */
export function parseRevision(value: string): Revision | undefined {
	const out: [number, number, number] = [0, 0, 0];
	let count = 0;
	for (const part of value.split(/[.-]/)) {
		if (count === 3) return undefined;
		const component = parseComponent(part);
		if (component === undefined) return undefined;
		out[count] = component;
		count++;
	}
	return count > 0 ? out : undefined;
}

/** Lexicographic triple comparison: negative, zero, or positive. */
export function compareRevision(a: Revision, b: Revision): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Best-effort model identity. Recognizes the Claude family/revision the shape
 * resolver cares about; other ids return an empty class and rely on
 * snapcompact's model-id regex table.
 */
export function classifyModel(_provider: string, modelId: string, _opts?: { lenient?: boolean }): ModelIdentity {
	const id = modelId.toLowerCase();
	if (!/(^|[^a-z])(claude|anthropic)/.test(id) && !id.includes("claude")) {
		return { class: "unknown" };
	}
	let family: string | undefined;
	if (id.includes("fable")) family = "fable";
	else if (id.includes("mythos")) family = "mythos";
	else if (id.includes("opus")) family = "opus";
	else if (id.includes("sonnet")) family = "sonnet";
	else if (id.includes("haiku")) family = "haiku";
	const match = id.match(/(\d+)[.-](\d+)/);
	return {
		class: "anthropic",
		...(family ? { family } : {}),
		...(match ? { revision: `${match[1]}.${match[2]}` } : {}),
	};
}

/**
 * Prompt dialect a model prefers. Snapcompact only consumes the Anthropic
 * decision (reasoning must be omitted for Claude readers, which trip the
 * `reasoning_extraction` classifier); every other line falls through.
 *
 * Mirrors `@oh-my-pi/pi-catalog/identity#preferredDialect`, narrowed to the
 * one class this shim can decide. Kept name-compatible so the call site reads
 * like omp's.
 */
export function preferredDialect(modelId: string): "anthropic" | "other" {
	return classifyModel("", modelId, { lenient: true }).class === "anthropic" ? "anthropic" : "other";
}
