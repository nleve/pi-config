/**
 * Context-budget math, ported from omp's `#computeSnapcompactMaxFrames` and
 * `#projectSnapcompactContextTokens`.
 *
 * Two guards, both cheap and both missing from a naive port:
 *
 *  - **Frame cap**: size the archive so kept history + text edges + frames fit
 *    the model window, instead of a flat "25% of window" guess. The cap is the
 *    min of the config limit, `MAX_FRAMES_DEFAULT`, the 3 MB data budget, and
 *    this model's provider image budget.
 *  - **Reduction guard**: after rendering, project the post-compaction context
 *    and *reject the archive if it does not actually shrink the context*. On
 *    Anthropic/OpenAI a frame holds roughly 4.2–4.8 chars per billed token —
 *    near text parity — so an archive can be technically valid and still be a
 *    net loss. Rejecting hands back to soft compaction.
 */
import { DEFAULT_COMPACTION_SETTINGS, estimateTokens } from "@earendil-works/pi-coding-agent";
import {
	FRAME_TOKEN_ESTIMATE,
	type Archive,
	type Shape,
	geometry,
} from "./vendor/snapcompact";
import { dataBudgetFrames, resolveFrameCountBudget, type BudgetTarget } from "./tuning";

/** The summary template (reading guide + FILES + grid notes) bills ~2k tokens. */
const SUMMARY_TEMPLATE_TOKENS = 2000;
/** tiktoken cl100k ≈ 4 chars/token on ASCII; 1.15 absorbs denser content. */
const CHARS_PER_TOKEN = 4;
const DENSITY_MARGIN = 1.15;

/** Token estimate for a list of pi messages (chars/4, pi's own estimator). */
export function tokensOfMessages(messages: readonly unknown[]): number {
	let sum = 0;
	for (const message of messages) {
		sum += estimateTokens(message as never);
	}
	return sum;
}

export interface MaxFramesInput {
	model: BudgetTarget & { contextWindow?: number };
	shape: Shape;
	/** Tokens of the history being replaced (messagesToSummarize + turn prefix). */
	sourceTokens: number;
	/** Whole-context estimate before compaction (pi's `tokensBefore`). */
	tokensBefore: number;
	/** Config upper limit. */
	configMaxFrames: number;
	/** Config image-budget override. */
	imageBudget?: number;
}

/**
 * Largest archive frame count whose re-attached form fits the window.
 * Returns 0 when there is no headroom at all (caller falls back), and 1 when
 * there is headroom for a minimal archive.
 */
export function computeMaxFrames(input: MaxFramesInput): number {
	const hardCap = Math.min(input.configMaxFrames, dataBudgetFrames(), resolveFrameCountBudget(input.model, input.imageBudget));
	const ctxWindow = input.model.contextWindow ?? 0;
	if (ctxWindow <= 0) {
		// No window knowledge: keep a modest, useful archive.
		return Math.max(1, Math.min(hardCap, 24));
	}

	const reserve = Math.max(DEFAULT_COMPACTION_SETTINGS.reserveTokens, Math.ceil(ctxWindow * 0.05));
	const totalBudget = ctxWindow - reserve;
	const baseTokens = Math.max(0, input.tokensBefore - input.sourceTokens);
	if (baseTokens >= totalBudget) return 0;

	// Text kept verbatim at both chronological edges (one HQ page each) plus the
	// summary template must survive alongside the frames.
	const edgeCap = geometry(input.shape).capacity;
	const textEdgeTokens = Math.ceil((2 * edgeCap * DENSITY_MARGIN) / CHARS_PER_TOKEN);
	const capReserve = textEdgeTokens + SUMMARY_TEMPLATE_TOKENS;

	const frameBudget = totalBudget - baseTokens - capReserve;
	if (frameBudget < FRAME_TOKEN_ESTIMATE) return 1;
	return Math.max(1, Math.min(Math.floor(frameBudget / FRAME_TOKEN_ESTIMATE), hardCap));
}

/** Billed-token estimate of a re-attached archive (frames + text edges + template). */
export function archiveTokens(archive: Archive, shape: Shape): number {
	const frames = archive.frames.length;
	const textChars = (archive.textHead?.length ?? 0) + (archive.textTail?.length ?? 0);
	const textTokens = Math.ceil((textChars * DENSITY_MARGIN) / CHARS_PER_TOKEN);
	return frames * shape.frameTokenEstimate + textTokens + SUMMARY_TEMPLATE_TOKENS;
}

export interface ReductionInput {
	model: BudgetTarget & { contextWindow?: number };
	shape: Shape;
	archive: Archive;
	tokensBefore: number;
	sourceTokens: number;
	/**
	 * Billed tokens of the previous archive standing in the context (frames +
	 * its text edges + summary), or the previous text summary when no archive
	 * exists. Zero on a first compaction.
	 */
	previousTokens?: number;
}

export interface ReductionVerdict {
	accept: boolean;
	/** Why the archive was rejected. */
	reason?: "no-reduction" | "no-fit";
	/** Whole-context estimate after compaction (for the notice). */
	projectedTokens: number;
	/** Local, usage-independent token size of the region the archive replaces. */
	baselineTokens: number;
	budgetTokens: number;
}

/**
 * omp's projection guard: accept only when the archive both *reduces* the
 * context and *fits* the window.
 *
 * The reduction test is deliberately **self-consistent and local**, mirroring
 * omp's `#projectPreSnapcompactContextTokens`: fixed overhead and the kept
 * recent history are identical before and after, so they cancel and the
 * archive only has to beat the region it replaces — the newly summarized
 * messages plus the standing previous archive. Anchoring on pi's
 * `tokensBefore` instead would let a deflated figure (a payload-shrinking
 * `before_provider_request` hook, an imported session with no usage) falsely
 * reject a reducing archive (omp #10023). `tokensBefore` is still used for the
 * conservative window-fit check, where the whole-context number is what
 * matters.
 */
export function guardReduction(input: ReductionInput): ReductionVerdict {
	const archiveSize = archiveTokens(input.archive, input.shape);
	const previousTokens = Math.max(0, input.previousTokens ?? 0);
	const baselineTokens = input.sourceTokens + previousTokens;
	const baseTokens = Math.max(0, input.tokensBefore - input.sourceTokens);
	const projectedTokens = baseTokens + archiveSize;
	const ctxWindow = input.model.contextWindow ?? 0;
	const reserve = ctxWindow > 0 ? Math.max(DEFAULT_COMPACTION_SETTINGS.reserveTokens, Math.ceil(ctxWindow * 0.05)) : 0;
	const budgetTokens = ctxWindow > 0 ? ctxWindow - reserve : Number.POSITIVE_INFINITY;

	if (archiveSize >= baselineTokens) {
		return { accept: false, reason: "no-reduction", projectedTokens, baselineTokens, budgetTokens };
	}
	if (projectedTokens >= budgetTokens) {
		return { accept: false, reason: "no-fit", projectedTokens, baselineTokens, budgetTokens };
	}
	return { accept: true, projectedTokens, baselineTokens, budgetTokens };
}
