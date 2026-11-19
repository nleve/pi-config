/**
 * Dynamic delegate declarations — `^<selector>[:<level>]`.
 *
 * The user tags a model inline in a prompt; we resolve it against the session
 * model catalogue, persist it as a branch-local delegate, and hand it back to
 * the `herdr` tool so `spawn model:"^selector[:level]"` compiles to
 * `--model <provider>/<id> [--thinking <level>]`.
 *
 * Single caret = a *new* delegate spec (this file).
 * Double caret (`^^name`) = an *existing* worker instance. That sigil is
 * reserved here and resolved later by the name registry; `@` is already pi's
 * file-reference sigil, so we do not use it.
 *
 * Everything is local and synchronous: no LLM call, no network. Unknown tokens
 * stay literal (like omp's `model_mention`), so ordinary text and regexes such
 * as `^foo` are left alone when `foo` is not a model in the catalogue.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVELS);

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return LEVEL_SET.has(value);
}

/**
 * Structural model shape — a subset of pi's `Model` so this module stays
 * dependency-free and unit-testable without the pi runtime.
 */
export interface ModelLike {
	id: string;
	name: string;
	provider: string;
	reasoning?: boolean;
	/** Missing keys use provider defaults; `null` marks a level unsupported. */
	thinkingLevelMap?: Partial<Record<string, string | null>>;
}

export interface Delegate {
	/** Selector text exactly as typed, e.g. `opus` or `gpt-5`. */
	token: string;
	/** Canonical `provider/id`. */
	selector: string;
	/** Catalogue display name. */
	name: string;
	/** Thinking level parsed from the mention, if any. */
	thinking?: ThinkingLevel;
	createdAt: number;
}

/** Session entry type for a persisted delegate (survives reload/resume/rewind). */
export const DELEGATE_ENTRY_TYPE = "herdr_delegate";

/** `^selector[:level]`, whitespace-delimited. Negative lookahead excludes `^^instance`. */
export const DELEGATE_RE = /(^|\s)\^(?!\^)([^\s^]+)(?=\s|$)/g;
/** `^^instance` refs (existing workers). Reserved; matched so `^^x` is not read as a model. */
export const INSTANCE_RE = /(^|\s)\^\^([^\s^]+)(?=\s|$)/g;

/**
 * Replace the `^`/`^^` token ending at `cursorCol` with `value`, preserving the
 * sigil that lives in `value`. Falls back to whitespace tokenization when
 * `prefix` no longer matches the text before the cursor.
 */
export function replaceMention(
	line: string,
	cursorCol: number,
	prefix: string,
	value: string,
): { line: string; cursorCol: number } {
	let start = cursorCol;
	if (prefix && line.slice(Math.max(0, cursorCol - prefix.length), cursorCol) === prefix) {
		start = cursorCol - prefix.length;
	} else {
		while (start > 0 && !/\s/.test(line[start - 1]!)) start--;
	}
	return { line: line.slice(0, start) + value + line.slice(cursorCol), cursorCol: start + value.length };
}

/**
 * Names referenced as `^^name` in `text` that exist in `names`, de-duped in
 * order of appearance. Unknown names are ignored (left literal).
 */
export function findInstanceRefs(text: string, names: ReadonlySet<string>): string[] {
	const refs: string[] = [];
	const seen = new Set<string>();
	INSTANCE_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = INSTANCE_RE.exec(text))) {
		const name = match[2]!;
		if (names.has(name) && !seen.has(name)) {
			seen.add(name);
			refs.push(name);
		}
	}
	return refs;
}

export interface DelegateEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

export interface ParsedSelector {
	model: ModelLike;
	level?: ThinkingLevel;
}

/** Exact `provider/id`, else an unambiguous bare `id`. */
export function resolveModelRef(models: readonly ModelLike[], ref: string): ModelLike | undefined {
	for (const m of models) {
		if (`${m.provider}/${m.id}` === ref) return m;
	}
	const bare = models.filter((m) => m.id === ref);
	return bare.length === 1 ? bare[0] : undefined;
}

/**
 * Parse `selector[:level]`. The full token is tried as a model first (so ids
 * containing colons survive); only then is a trailing valid level split off.
 */
export function parseSelectorLevel(
	token: string,
	models: readonly ModelLike[],
): ParsedSelector | undefined {
	const direct = resolveModelRef(models, token);
	if (direct) return { model: direct };
	const idx = token.lastIndexOf(":");
	if (idx > 0) {
		const level = token.slice(idx + 1);
		if (isThinkingLevel(level)) {
			const model = resolveModelRef(models, token.slice(0, idx));
			if (model && supportedLevels(model).includes(level)) return { model, level };
		}
	}
	return undefined;
}

/** Match Pi's supported levels: extended levels must be explicitly advertised. */
export function supportedLevels(model: ModelLike): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		return mapped !== null && ((level !== "xhigh" && level !== "max") || mapped !== undefined);
	});
}

function selectorOf(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

function formatLegend(delegates: readonly Delegate[], models: readonly ModelLike[]): string {
	const lines = delegates.map((d) => {
		const model = models.find((m) => selectorOf(m) === d.selector);
		const levels = model ? ` · supports: ${supportedLevels(model).join("|")}` : "";
		const thinking = d.thinking ? `thinking ${d.thinking}` : "thinking default";
		return `  ^${d.token} → ${d.selector} · ${thinking}${levels}`;
	});
	return [
		"Delegates requested (use the `delegate` tool with `model` set to the token):",
		...lines,
	].join("\n");
}

export interface DelegateRegistryHost {
	/** Session model catalogue (scoped models when configured, else all available). */
	availableModels: () => readonly ModelLike[];
	/** Persist a newly-seen delegate as a branch-local entry. */
	persist: (delegate: Delegate) => void;
}

/**
 * Branch-local delegate table. `sync()` rebuilds it from persisted entries so
 * resume/rewind work; `expand()` turns the current prompt's `^` tokens into
 * delegates; `resolveModelArgs()` compiles a `model` request to pi CLI flags.
 */
export class DelegateRegistry {
	readonly #byToken = new Map<string, Delegate>();
	readonly #bySelector = new Map<string, Delegate>();
	readonly #host: DelegateRegistryHost;

	constructor(host: DelegateRegistryHost) {
		this.#host = host;
	}

	/** Rebuild from persisted branch entries. Idempotent. */
	sync(entries: readonly DelegateEntryLike[]): void {
		this.#byToken.clear();
		this.#bySelector.clear();
		for (const entry of entries) {
			if (entry?.customType !== DELEGATE_ENTRY_TYPE) continue;
			const d = entry.data as Delegate | undefined;
			if (!d || typeof d.token !== "string" || typeof d.selector !== "string") continue;
			if (this.#byToken.has(d.token)) continue;
			this.#byToken.set(d.token, d);
			if (!this.#bySelector.has(d.selector)) this.#bySelector.set(d.selector, d);
		}
	}

	get all(): readonly Delegate[] {
		return [...this.#byToken.values()];
	}

	/** Look up by token (`^opus`, `opus`) or canonical selector. */
	find(token: string): Delegate | undefined {
		const key = token.startsWith("^") ? token.slice(1) : token;
		return this.#byToken.get(key) ?? this.#bySelector.get(key);
	}

	/**
	 * Resolve every `^selector[:level]` in `text`. Resolvable tokens are
	 * registered (and persisted once); unresolvable ones are left literal. When
	 * at least one delegate is found, the returned text carries a legend so the
	 * model knows what each token means and how to spawn it.
	 */
	expand(text: string): { text: string; delegates: Delegate[]; legend?: string } {
		if (!text.includes("^")) return { text, delegates: [] };
		const models = this.#host.availableModels();
		const found: Delegate[] = [];
		const seen = new Set<string>();
		DELEGATE_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = DELEGATE_RE.exec(text))) {
			const token = match[2]!;
			let delegate = this.#byToken.get(token);
			if (!delegate) {
				const parsed = parseSelectorLevel(token, models);
				if (!parsed) continue; // not a model → leave literal
				delegate = {
					token,
					selector: selectorOf(parsed.model),
					name: parsed.model.name || parsed.model.id,
					...(parsed.level ? { thinking: parsed.level } : {}),
					createdAt: Date.now(),
				};
				this.#byToken.set(token, delegate);
				if (!this.#bySelector.has(delegate.selector)) this.#bySelector.set(delegate.selector, delegate);
				this.#host.persist(delegate);
			}
			if (!seen.has(delegate.token)) {
				seen.add(delegate.token);
				found.push(delegate);
			}
		}
		if (found.length === 0) return { text, delegates: [] };
		const legend = formatLegend(found, models);
		return { text: `${text}\n\n${legend}`, delegates: found, legend };
	}

	/**
	 * Compile a `model` + `thinking` request to pi CLI args.
	 * Accepts a raw selector, a `^delegate` token, or a canonical selector of a
	 * known delegate. `thinking` overrides the delegate's declared level.
	 */
	resolveModelArgs(model?: string, thinking?: string): { args: string[]; error?: string } {
		const spec = model?.trim();
		if (spec?.startsWith("^^")) {
			return { args: [], error: `${spec} addresses an existing worker, not a model` };
		}
		const override = thinking?.trim();
		if (spec?.startsWith("^")) {
			const delegate = this.find(spec);
			if (!delegate) {
				return {
					args: [],
					error: `unknown delegate ${spec}; it must be declared as ^${spec.slice(1)} in a user prompt first`,
				};
			}
			const args = ["--model", delegate.selector];
			const level = override || delegate.thinking;
			if (level) args.push("--thinking", level);
			return { args };
		}
		const args: string[] = [];
		if (spec) args.push("--model", spec);
		if (override) args.push("--thinking", override);
		return { args };
	}
}
