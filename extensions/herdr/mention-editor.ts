import { CURSOR_MARKER, renderFakeCursor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MentionStyle } from "./mentions.ts";

const [cursorStart, cursorEnd] = renderFakeCursor("\0").split("\0");
const ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]P_^][^\x07\x1b]*(?:\x07|\x1b\\))/g;

/** Decorate rendered rows, not the draft. Leave layout and editing with Pi. */
export function highlightMentionRow(
	row: string,
	mentions: ReadonlyMap<string, MentionStyle>,
	style: (kind: MentionStyle, text: string) => string,
	titles?: ReadonlyMap<string, string>,
): string {
	if (!row.includes("^")) return row;
	let plain = "";
	const positions: number[] = [];
	let source = 0;
	function appendPlain(end: number) {
		plain += row.slice(source, end);
		for (let i = source; i < end; i++) positions.push(i);
	}
	for (const escape of row.matchAll(ESCAPE)) {
		appendPlain(escape.index!);
		source = escape.index! + escape[0].length;
	}
	appendPlain(row.length);

	let out = "";
	let copied = 0;
	// The editor has already wrapped and padded this row. Use only spare
	// trailing cells for longer labels; never change its layout or cursor bytes.
	const padding = / +$/.exec(row)?.[0].length ?? 0;
	let extra = 0;
	for (const token of plain.matchAll(/(?:^|\s)(\^\^?[^\s^]+)(?=\s|$)/g)) {
		const kind = mentions.get(token[1]!);
		if (!kind) continue;
		const from = token.index! + token[0].length - token[1]!.length;
		let start = positions[from]!;
		let end = positions[from + token[1]!.length - 1]! + 1;
		// Keep Pi's hardware cursor marker adjacent to the fake cursor start.
		if (cursorStart && row.slice(0, start).endsWith(cursorStart)) {
			start -= cursorStart.length;
			if (row.slice(0, start).endsWith(CURSOR_MARKER)) start -= CURSOR_MARKER.length;
		}
		if (cursorEnd && row.startsWith(cursorEnd, end)) end += cursorEnd.length;
		const original = row.slice(start, end);
		const title = titles?.get(token[1]!);
		let display = original;
		// Keep the raw handle visible whenever the cursor is editing it.
		if (title && !original.includes("\x1b")) {
			const width = visibleWidth(original);
			display = truncateToWidth(title, width + Math.max(0, padding - extra), "…");
			extra += visibleWidth(display) - width;
		}
		out += row.slice(copied, start) + style(kind, display);
		copied = end;
	}
	return out + row.slice(copied, extra > 0 ? row.length - extra : row.length) + (extra < 0 ? " ".repeat(-extra) : "");
}
