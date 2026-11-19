// Minimal stand-in for the `@oh-my-pi/pi-ai` types snapcompact imports.
// These are type-only; the runtime never touches this module.
export type Api = string;

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
	detail?: "auto" | "low" | "high" | "original";
}

export interface Message {
	role: string;
	content: unknown;
	timestamp?: number;
	[key: string]: unknown;
}
