// Loads the snapcompact rasterizer from omp's native N-API addon.
//
// omp's own `@oh-my-pi/pi-natives` JS loader is Bun-only (it reads
// `import.meta.dir`, which Node does not define), so we skip it and require the
// platform addon file directly. The addon is ABI-stable N-API, so Node can load
// exactly the same `.node` omp uses.
//
// Resolution order:
//   1. PI_SNAPCOMPACT_ADDON  — explicit `.node` file or directory (wins)
//   2. @oh-my-pi/pi-natives-<platform>-<arch> reachable from here (node_modules)
//   3. Bun's global install dir ($BUN_INSTALL/install/global/node_modules)
//   4. npm's global root ($(npm root -g))
//   5. omp's staged natives dir ($XDG_DATA_HOME/omp/natives, ~/.omp/natives)
//
// Within each directory we try the `-modern` addon first (AVX2) and fall back
// to `-baseline`.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface SnapcompactAddon {
	renderSnapcompactPng(text: string, options: Record<string, unknown>): Promise<string>;
	snapcompactSupportedChars(font: string, chars: string): string;
}

const platformTag = `${process.platform}-${process.arch}`;
const leafPackage = `@oh-my-pi/pi-natives-${platformTag}`;

function addonFilenames(): string[] {
	return [`pi_natives.${platformTag}-modern.node`, `pi_natives.${platformTag}-baseline.node`];
}

function candidateDirs(): string[] {
	const dirs: string[] = [];
	const push = (value: string | undefined) => {
		if (value && !dirs.includes(value)) dirs.push(value);
	};

	// 2. Reachable from the extension's own module graph.
	try {
		const require_ = createRequire(import.meta.url);
		push(path.dirname(require_.resolve(`${leafPackage}/package.json`)));
	} catch {
		/* not installed locally */
	}

	// 3. Bun global install.
	const bunInstall = process.env.BUN_INSTALL ?? path.join(os.homedir(), ".bun");
	push(path.join(bunInstall, "install", "global", "node_modules", leafPackage));

	// 4. npm global root.
	const npmGlobal = process.env.NPM_CONFIG_PREFIX ?? path.join(os.homedir(), ".npm-global");
	push(path.join(npmGlobal, "lib", "node_modules", leafPackage));
	push(path.join(npmGlobal, "node_modules", leafPackage));

	// 5. omp staged natives (version subdirectories are scanned below).
	const dataHome = process.env.XDG_DATA_HOME;
	push(path.join(dataHome ?? path.join(os.homedir(), ".local", "share"), "omp", "natives"));
	push(path.join(os.homedir(), ".omp", "natives"));

	return dirs;
}

/** Expand a directory into concrete `.node` paths (searching version subdirs). */
function expandCandidates(entry: string): string[] {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(entry);
	} catch {
		return [];
	}
	if (stat.isFile()) return entry.endsWith(".node") ? [entry] : [];

	const found: string[] = [];
	const names = addonFilenames();
	const visit = (dir: string, depth: number) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const name of names) {
			const direct = path.join(dir, name);
			if (fs.existsSync(direct)) found.push(direct);
		}
		if (depth >= 2) return;
		for (const child of entries) {
			if (child.isDirectory()) visit(path.join(dir, child.name), depth + 1);
		}
	};
	visit(entry, 0);
	return found;
}

let cached: SnapcompactAddon | undefined;

function loadAddon(): SnapcompactAddon {
	if (cached) return cached;

	const explicit = process.env.PI_SNAPCOMPACT_ADDON;
	const directCandidates: string[] = [];
	if (explicit) {
		if (explicit.endsWith(".node")) directCandidates.push(explicit);
		else directCandidates.push(...expandCandidates(explicit));
	}
	for (const dir of candidateDirs()) directCandidates.push(...expandCandidates(dir));

	const require_ = createRequire(import.meta.url);
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const file of directCandidates) {
		if (seen.has(file)) continue;
		seen.add(file);
		try {
			const addon = require_(file) as SnapcompactAddon;
			if (typeof addon.renderSnapcompactPng !== "function") {
				errors.push(`${file}: missing renderSnapcompactPng`);
				continue;
			}
			cached = addon;
			return addon;
		} catch (err) {
			errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	throw new Error(
		[
			"snapcompact could not load omp's native renderer.",
			`Tried ${directCandidates.length} candidate path(s):`,
			...errors.map(line => `  ${line}`),
			"Install @oh-my-pi/pi-natives or point PI_SNAPCOMPACT_ADDON at a pi_natives*.node file.",
		].join("\n"),
	);
}

export function renderSnapcompactPng(text: string, options: Record<string, unknown>): Promise<string> {
	return loadAddon().renderSnapcompactPng(text, options);
}

export function snapcompactSupportedChars(font: string, chars: string): string {
	return loadAddon().snapcompactSupportedChars(font, chars);
}
