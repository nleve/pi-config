/**
 * Provider/model tuning, ported from omp.
 *
 * Snapcompact's own engine already resolves the *shape* (and thus the per-frame
 * token price) from `model.api`. What it leaves to the caller — and what omp's
 * native integration supplies — is the per-request *image count* budget and the
 * provider-derived fallbacks. This module is that layer.
 *
 * omp keys the count budget on its own provider ids (`anthropic`, `openai`, …)
 * because omp only talks to providers it recognizes. Pi fronts many models
 * through gateways (`opencode-go`, `openrouter`, …) whose provider id is not in
 * the table, so a literal lookup would hit omp's strict `unknown → 5` floor and
 * strangle otherwise-fine archives. Instead we fall back to the billing family
 * implied by `model.api`, and finally to a gateway-friendly default that can be
 * overridden from config.
 */
import {
	MAX_FRAMES_DEFAULT,
	PROVIDER_IMAGE_BUDGETS,
	maxFramesForDataBudget,
	providerImageBudget,
} from "./vendor/snapcompact";

export type BillingFamily = "anthropic" | "openai" | "google" | "unknown";

/** Same api→family mapping the engine uses for frame billing. */
export function billingFamilyOfApi(api: unknown): BillingFamily {
	switch (api) {
		case "anthropic-messages":
		case "bedrock-converse-stream":
			return "anthropic";
		case "openai-completions":
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
			return "openai";
		case "google-generative-ai":
		case "google-gemini-cli":
		case "google-vertex":
			return "google";
		default:
			return "unknown";
	}
}

/**
 * Gateway default when neither the provider id nor the api family is in omp's
 * table. omp floors unknown providers at 5 (measured on Groq); a pi gateway is
 * usually a proxy to a first-class vendor, so 5 is needlessly strict. Keep it
 * well under every vendor hard cap (Anthropic 100, OpenAI 500) while leaving
 * room for a real archive.
 */
export const GATEWAY_IMAGE_BUDGET = 100;

export interface BudgetTarget {
	provider?: string;
	api?: unknown;
}

/** Per-request image-count budget: provider table → api family → gateway floor. */
export function resolveImageCountBudget(model: BudgetTarget | undefined, override?: number): number {
	if (typeof override === "number" && Number.isFinite(override) && override > 0) {
		return Math.floor(override);
	}
	const provider = model?.provider;
	if (provider && Object.hasOwn(PROVIDER_IMAGE_BUDGETS, provider)) {
		return PROVIDER_IMAGE_BUDGETS[provider] as number;
	}
	switch (billingFamilyOfApi(model?.api)) {
		case "anthropic":
			return PROVIDER_IMAGE_BUDGETS.anthropic as number;
		case "openai":
			return PROVIDER_IMAGE_BUDGETS.openai as number;
		case "google":
			return PROVIDER_IMAGE_BUDGETS.google as number;
		default:
			return GATEWAY_IMAGE_BUDGET;
	}
}

/** Archive frame cap for this model: image budget, never above MAX_FRAMES_DEFAULT. */
export function resolveFrameCountBudget(model: BudgetTarget | undefined, override?: number): number {
	return Math.min(resolveImageCountBudget(model, override), MAX_FRAMES_DEFAULT);
}

/** Data-budget frame cap (3 MB of base64 at the engine's per-frame estimate). */
export function dataBudgetFrames(): number {
	return maxFramesForDataBudget();
}

/** Re-export for callers that only want the raw provider table value. */
export { providerImageBudget };
