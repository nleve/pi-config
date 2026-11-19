import { DELEGATE_RE, findInstanceRefs, INSTANCE_RE, parseSelectorLevel, supportedLevels, type DelegateRegistry, type ModelLike } from "./delegates.ts";

interface MentionItem {
	value: string;
	label: string;
	description: string;
}

export interface MentionWorker {
	name: string;
	/** Absent for a dormant, mailbox-only identity. Never pass a stale pane. */
	pane?: string;
	project?: string;
}

export function modelMentionItems(models: readonly ModelLike[], query: string): MentionItem[] {
	const counts = new Map<string, number>();
	for (const model of models) counts.set(model.id, (counts.get(model.id) ?? 0) + 1);
	const rows = models.map(model => {
		const canonical = `${model.provider}/${model.id}`;
		const selector = counts.get(model.id) === 1 ? model.id : canonical;
		return { model, canonical, selector };
	});
	const matches = (row: (typeof rows)[number], needle: string) =>
		[row.canonical, row.model.name].some(value => value.toLowerCase().includes(needle));
	const q = query.toLowerCase();
	const choices = rows.filter(row => matches(row, q)).slice(0, 30).map(({ model, selector }) => ({
		value: `^${selector}`,
		label: selector,
		description: `${model.provider} · new delegate`,
	}));
	const colon = q.lastIndexOf(":");
	if (colon <= 0) return choices;
	const base = q.slice(0, colon);
	const levelPrefix = q.slice(colon + 1);
	const exact = rows.filter(row => row.selector.toLowerCase() === base || row.canonical.toLowerCase() === base);
	for (const { model, selector } of (exact.length > 0 ? exact : rows.filter(row => matches(row, base))).slice(0, 3)) {
		for (const level of supportedLevels(model)) {
			const token = `${selector}:${level}`;
			if (level.startsWith(levelPrefix) && parseSelectorLevel(token, models)?.level === level) {
				choices.push({ value: `^${token}`, label: token, description: `${model.provider} · thinking ${level}` });
			}
		}
	}
	return choices.slice(0, 30);
}

export function workerMentionItems(workers: readonly MentionWorker[], query: string): MentionItem[] {
	const q = query.toLowerCase();
	return workers.filter(worker => worker.name.toLowerCase().includes(q))
		.sort((a, b) => Number(Boolean(b.pane)) - Number(Boolean(a.pane)) || a.name.localeCompare(b.name))
		.slice(0, 30)
		.map(({ name, pane, project }) => ({
			value: `^^${name}`,
			label: name,
			description: [pane ? `live · ${pane}` : "offline · mail waits for resume", project].filter(Boolean).join(" · "),
		}));
}

const START = "\n\n<!-- herdr:mention-routing -->\n";
const END = "\n<!-- /herdr:mention-routing -->";

/** Keep the routing instructions with the prompt so queueing/replay need no UI state. */
export function appendMentionRouting(text: string, modelLegend: string | undefined, workers: readonly MentionWorker[]): string {
	const byName = new Map(workers.map(worker => [worker.name, worker]));
	const refs = findInstanceRefs(text, new Set(byName.keys())).map(name => byName.get(name)!);
	const sections = [modelLegend];
	if (refs.length > 0) {
		sections.push([
			"Worker references (use herdr or IRC for live workers; use only IRC for dormant workers, which are not woken by mail):",
			...refs.map(({ name, pane }) => `  ^^${name} → ${pane ? `live · ${pane}` : "dormant · IRC mailbox only"}`),
		].join("\n"));
	}
	const routing = sections.filter(Boolean).join("\n");
	return routing ? `${text}${START}${routing}${END}` : text;
}

export type MentionStyle = "model" | "worker" | "offline";

/** Same whitespace boundaries as submission. No persistence or tool calls when typing. */
export function draftMentions(
	text: string,
	models: readonly ModelLike[],
	delegates: Pick<DelegateRegistry, "find">,
	getWorkers: () => readonly MentionWorker[],
): Map<string, MentionStyle> {
	const found = new Map<string, MentionStyle>();
	if (!text.includes("^") || /^[!$]/.test(text.trimStart())) return found;
	for (const match of text.matchAll(DELEGATE_RE)) {
		const token = match[2]!;
		const mention = `^${token}`;
		if (found.has(mention)) continue;
		if (delegates.find(mention)?.token === token || parseSelectorLevel(token, models)) found.set(mention, "model");
	}
	if (text.includes("^^")) {
		const workers = new Map(getWorkers().map(worker => [worker.name, worker]));
		for (const name of findInstanceRefs(text, new Set(workers.keys()))) {
			found.set(`^^${name}`, workers.get(name)?.pane ? "worker" : "offline");
		}
	}
	return found;
}

function inlineCode(text: string): string {
	const ticks = "`".repeat(1 + Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length)));
	return text.includes("`") ? `${ticks} ${text} ${ticks}` : `${ticks}${text}${ticks}`;
}

/** Style resolved tokens in the original message, without showing routing metadata. */
export function renderMentionMessage(markdown: string): string {
	// Machine correlation tag, not part of the task people need to read.
	markdown = markdown.replace(/^<!-- herdr:assignment [0-9a-f-]{36} -->\n/, "");
	const start = markdown.lastIndexOf(START);
	if (start < 0) return markdown;
	const end = markdown.indexOf(END, start + START.length);
	if (end < 0) return markdown;
	const routing = markdown.slice(start + START.length, end);
	const mentions = new Set<string>();
	for (const line of routing.split("\n")) {
		const row = /^  (\^\^?[^\s^]+) → /.exec(line);
		if (row?.[1]) mentions.add(row[1]);
	}
	if (!mentions.size) return markdown;
	let body = markdown.slice(0, start);
	for (const [regex, sigil] of [[INSTANCE_RE, "^^"], [DELEGATE_RE, "^"]] as const) {
		body = body.replace(regex, (match, whitespace: string, token: string) => {
			const mention = sigil + token;
			return mentions.has(mention) ? whitespace + inlineCode(mention) : match;
		});
	}
	return body + markdown.slice(end + END.length);
}

/** Use ^^ only for a handle that can actually be pasted into the composer. */
export function workerHandle(name: string): string {
	return /^[A-Za-z0-9_-]+$/.test(name) ? `^^${name}` : name;
}
