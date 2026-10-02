/**
 * Auto-generated worker names.
 *
 * A worker's identity must be stable and memorable, and must NOT be the model
 * name: four workers on the same model would otherwise be indistinguishable.
 * We mint a Docker-style `adjective-noun` codename instead and show the model /
 * thinking level as metadata beside it. The user can always `agent_rename` a
 * worker to something more meaningful; the codename is only the default.
 */

const ADJECTIVES = [
	"amber", "arctic", "brisk", "calm", "clever", "coral", "crimson", "daring",
	"dusty", "eager", "fleet", "fuzzy", "gentle", "glossy", "golden", "grand",
	"happy", "hollow", "humble", "ivory", "jolly", "keen", "lively", "lucid",
	"lucky", "mellow", "mighty", "misty", "nimble", "noble", "olive", "plucky",
	"proud", "quiet", "rapid", "rustic", "sable", "sharp", "silent", "silver",
	"sleek", "smoky", "snappy", "solar", "spry", "steady", "sunny", "swift",
	"tidy", "vivid", "warm", "witty", "zesty", "brave", "bright", "bold",
	"cosmic", "curious", "deft", "lunar", "polar", "rugged", "stark", "velvet",
];

const NOUNS = [
	"otter", "falcon", "cedar", "harbor", "lantern", "meadow", "anchor", "badger",
	"beacon", "bison", "brook", "canyon", "cobra", "comet", "condor", "crane",
	"dune", "ember", "fern", "forge", "fox", "garnet", "glacier", "grove",
	"gull", "hazel", "heron", "hollow", "ibis", "jaguar", "juniper", "kestrel",
	"lark", "lynx", "maple", "marlin", "mesa", "moth", "oak", "onyx",
	"orchid", "osprey", "otter", "panda", "pebble", "pike", "pine", "puffin",
	"quartz", "raven", "reef", "ridge", "robin", "rowan", "salmon", "sparrow",
	"spruce", "summit", "thistle", "tiger", "tundra", "walrus", "willow", "wren",
];

function pick<T>(arr: readonly T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * A fresh memorable codename. Pass `used` (the session's taken names) to avoid
 * collisions; after a bounded number of tries we append a numeric suffix so the
 * caller always gets a unique name rather than looping.
 */
/**
 * Sanitize one component of a derived agent name to herdr's charset
 * (`^[a-z][a-z0-9_-]{0,31}$`): lowercase, `[a-z0-9]` with `-` separators,
 * leading non-letters stripped, capped at `max`. Never returns empty.
 */
export function namePart(raw: string, max = 12): string {
	const s = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/^[^a-z]+/, "")
		.slice(0, max)
		.replace(/-+$/g, "");
	return s || "wf";
}

/**
 * Deterministic worker name for a workflow/stage slot: `<group>-<stage>-<n>`.
 * Sanitized for herdr and capped at 32 chars. When `taken` already holds the
 * name, a numeric suffix is appended rather than colliding (parallel spawns).
 */
export function stageName(
	group: string,
	stage: string,
	index: number,
	taken?: ReadonlySet<string>,
): string {
	const g = namePart(group, 12);
	const s = namePart(stage, 10);
	const base = `${g}-${s}-${index}`.slice(0, 32).replace(/-+$/g, "");
	if (!taken?.has(base)) return base;
	for (let k = 2; k < 1000; k++) {
		const suffix = `-${k}`;
		const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`.replace(/-+$/g, "");
		if (!taken.has(candidate)) return candidate;
	}
	return base;
}

export function generateName(used?: ReadonlySet<string>): string {
	for (let i = 0; i < 64; i++) {
		const name = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
		if (!used?.has(name)) return name;
	}
	const name = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
	let n = 2;
	while (used?.has(`${name}-${n}`)) n++;
	return `${name}-${n}`;
}
