/**
 * Delegate (`^selector[:level]`) resolution + registry tests.
 * Run: bun test/delegates.test.ts
 */
import {
	DelegateRegistry,
	DELEGATE_ENTRY_TYPE,
	findInstanceRefs,
	parseSelectorLevel,
	replaceMention,
	resolveModelRef,
	supportedLevels,
	type Delegate,
	type ModelLike,
} from "../delegates.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
	if (!cond) failures++;
}

const MODELS: ModelLike[] = [
	{
		id: "claude-opus-4",
		name: "Claude Opus 4",
		provider: "anthropic",
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: null },
	},
	{ id: "gpt-5", name: "GPT-5", provider: "openai", reasoning: true },
	{ id: "llama-3", name: "Llama 3", provider: "meta", reasoning: false },
	{ id: "foo:exacto", name: "Foo Exacto", provider: "openrouter", reasoning: true },
];

// ---- pure helpers ---------------------------------------------------------

check("resolve bare unique id", resolveModelRef(MODELS, "gpt-5")?.provider === "openai");
check("resolve canonical", resolveModelRef(MODELS, "anthropic/claude-opus-4")?.id === "claude-opus-4");
check("ambiguous bare id rejected", resolveModelRef([...MODELS, { id: "gpt-5", name: "x", provider: "other" }], "gpt-5") === undefined);
check("parse selector:level", parseSelectorLevel("gpt-5:high", MODELS)?.level === "high");
check("parse id with colon (no level)", parseSelectorLevel("foo:exacto", MODELS)?.model.id === "foo:exacto");
check("unknown returns undefined", parseSelectorLevel("nope", MODELS) === undefined);
check("supported levels: reasoning", supportedLevels(MODELS[0]!).join("|") === "off|minimal|low|medium|high");
check("supported levels: no reasoning -> off", supportedLevels(MODELS[2]!).join("|") === "off");

// ---- registry -------------------------------------------------------------

const persisted: Delegate[] = [];
const reg = new DelegateRegistry({
	availableModels: () => MODELS,
	persist: (d) => persisted.push(d),
});

let r = reg.expand("please ^claude-opus-4:high review this");
check(
	"expand resolves ^model:level",
	r.delegates.length === 1 &&
		r.delegates[0]!.selector === "anthropic/claude-opus-4" &&
		r.delegates[0]!.thinking === "high",
);
check("legend appended", r.text.includes("^claude-opus-4:high → anthropic/claude-opus-4"));
check("persisted once", persisted.length === 1);

r = reg.expand("again ^claude-opus-4:high");
check("re-mention reuses (no double persist)", persisted.length === 1 && r.delegates.length === 1);

r = reg.expand("here is a regex ^foo$ and prose");
check("unknown token stays literal", r.delegates.length === 0 && r.text === "here is a regex ^foo$ and prose");

r = reg.expand("ping ^^otter about it");
check("^^ instance ref is not a delegate", r.delegates.length === 0);

r = reg.expand("mixed ^gpt-5 and ^llama-3:off");
check("multiple delegates", r.delegates.length === 2);
check("unsupported thinking level stays literal", reg.expand("^llama-3:high").delegates.length === 0);

// ---- resolveModelArgs -----------------------------------------------------

check("raw selector", reg.resolveModelArgs("openai/gpt-5").args.join(" ") === "--model openai/gpt-5");
check("raw selector + thinking", reg.resolveModelArgs("openai/gpt-5", "low").args.join(" ") === "--model openai/gpt-5 --thinking low");
check(
	"^token uses declared level",
	reg.resolveModelArgs("^claude-opus-4:high").args.join(" ") === "--model anthropic/claude-opus-4 --thinking high",
);
check(
	"^token thinking override",
	reg.resolveModelArgs("^claude-opus-4:high", "low").args.join(" ") === "--model anthropic/claude-opus-4 --thinking low",
);
check("unknown ^token errors", reg.resolveModelArgs("^missing").error !== undefined);
check("^^ is not a model", reg.resolveModelArgs("^^otter").error !== undefined);

// ---- sync -----------------------------------------------------------------

const reg2 = new DelegateRegistry({ availableModels: () => MODELS, persist: () => {} });
reg2.sync([
	{ customType: DELEGATE_ENTRY_TYPE, data: { token: "gpt-5", selector: "openai/gpt-5", name: "GPT-5", createdAt: 0 } },
	{ customType: "something_else", data: { token: "nope" } },
]);
check("sync rebuilds from entries", reg2.find("^gpt-5")?.selector === "openai/gpt-5");
check("sync ignores other entry types", reg2.find("nope") === undefined);

// ---- ^^ instance refs ------------------------------------------------------

const live = new Set(["amber-otter", "brisk-falcon"]);
check(
	"instance refs: known names in order",
	findInstanceRefs("ask ^^brisk-falcon then ^^amber-otter", live).join(",") === "brisk-falcon,amber-otter",
);
check("instance refs: de-duped", findInstanceRefs("^^amber-otter and ^^amber-otter", live).length === 1);
check("instance refs: unknown ignored", findInstanceRefs("^^ghost", live).length === 0);
check("instance refs: single caret is not an instance", findInstanceRefs("^amber-otter", live).length === 0);
check("instance refs: mid-word caret ignored", findInstanceRefs("x^^amber-otter", live).length === 0);

// ---- completion replacement (the `^` must survive) -------------------------

const single = replaceMention("^deep", 5, "^deep", "^deepseek-v4.1-flash");
check("replaceMention keeps single caret", single.line === "^deepseek-v4.1-flash", single.line);
const double = replaceMention("use ^^cor", 9, "^^cor", "^^coral-tiger");
check("replaceMention keeps double caret", double.line === "use ^^coral-tiger", double.line);
check("replaceMention places cursor after value", double.cursorCol === 17, String(double.cursorCol));
const mid = replaceMention("hello ^de world", 9, "^de", "^deepseek");
check("replaceMention splices mid-line", mid.line === "hello ^deepseek world", mid.line);
const fallback = replaceMention("hi ^de", 6, "nope", "^deep");
check("replaceMention falls back to whitespace token", fallback.line === "hi ^deep", fallback.line);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
