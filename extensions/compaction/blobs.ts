/**
 * Content-addressed frame store, following omp's blob store.
 *
 * omp externalizes frame base64 out of the session JSONL: an entry holds a
 * `blob:sha256:<hex>` reference and the bytes live in a content-addressed
 * directory. The engine already understands this — `historyBlocks` accepts a
 * `resolveFrameData` callback and drops a frame that stays an unresolved
 * reference rather than sending `"blob:..."` to the provider as image data.
 *
 * Writes are staged through a temp file and renamed into place, so a
 * hash-named blob is never observed half-written, and a reused blob gets its
 * mtime refreshed so a concurrent GC's write-grace still covers a reference
 * that has not reached a session file yet. {@link gcBlobs} is the reclaimer:
 * it scans session transcripts for `blob:sha256:` references and deletes only
 * blobs that are both unreferenced and older than a retention window.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Archive, LazyFrameData } from "./vendor/snapcompact";

export const BLOB_REFERENCE_PREFIX = "blob:sha256:";
const HASH_RE = /^[a-f0-9]{64}$/;
const BLOB_REF_RE = /\bblob:sha256:([a-f0-9]{64})\b/gi;
/** A staging temp we wrote: `.<hash>.<16 hex>.tmp`. */
const STAGING_RE = /^\.[a-f0-9]{64}\.[0-9a-f]{16}\.tmp$/;

/** A reused blob older than this gets its mtime refreshed (metadata only). */
const REUSE_TOUCH_MS = 60_000;
/** Never delete a blob younger than this: its reference may not be persisted. */
export const BLOB_WRITE_GRACE_MS = 5 * 60_000;
/** Delete unreferenced blobs only after they have been idle this long. */
export const BLOB_DEFAULT_RETAIN_MS = 30 * 86_400_000;
/** Minimum spacing between opportunistic background sweeps. */
export const BLOB_AUTO_GC_INTERVAL_MS = 6 * 3_600_000;

export function blobDir(): string {
	return path.join(getAgentDir(), "snapcompact", "blobs");
}

export function isBlobReference(data: string): boolean {
	return data.startsWith(BLOB_REFERENCE_PREFIX);
}

function hashOf(raw: Buffer): string {
	return createHash("sha256").update(raw).digest("hex");
}

function touchIfStale(file: string, mtimeMs: number): void {
	if (Date.now() - mtimeMs <= REUSE_TOUCH_MS) return;
	try {
		const now = new Date();
		fs.utimesSync(file, now, now);
	} catch {
		// A missing blob will be rewritten or dropped by the caller.
	}
}

/** Store base64 frame bytes and return the `blob:sha256:` reference. */
export function putFrame(dataB64: string): string {
	const raw = Buffer.from(dataB64, "base64");
	const hash = hashOf(raw);
	const dir = blobDir();
	const file = path.join(dir, hash);
	try {
		fs.mkdirSync(dir, { recursive: true });
		let reused = false;
		try {
			const stat = fs.statSync(file);
			if (stat.size === raw.length) {
				reused = true;
				touchIfStale(file, stat.mtimeMs);
			}
		} catch {
			// Not stored yet.
		}
		if (!reused) {
			// Stage beside the target so the rename is atomic on the same volume.
			const tmp = path.join(dir, `.${hash}.${randomBytes(8).toString("hex")}.tmp`);
			fs.writeFileSync(tmp, raw);
			fs.renameSync(tmp, file);
		}
	} catch {
		// Storage failure is non-fatal: fall back to inline base64.
		return dataB64;
	}
	return BLOB_REFERENCE_PREFIX + hash;
}

/** Resolve a frame payload for `historyBlocks`: inline base64 or a blob ref. */
export function resolveFrameData(data: string): LazyFrameData | undefined {
	if (!isBlobReference(data)) {
		return { bytes: data.length, read: () => data };
	}
	const hash = data.slice(BLOB_REFERENCE_PREFIX.length);
	if (!HASH_RE.test(hash)) return undefined;
	const file = path.join(blobDir(), hash);
	try {
		const raw = fs.readFileSync(file);
		try {
			touchIfStale(file, fs.statSync(file).mtimeMs);
		} catch {
			// Read succeeded; the touch is best-effort.
		}
		return { bytes: raw.length, read: () => raw.toString("base64") };
	} catch {
		return undefined;
	}
}

/** Resolved base64 byte length of every frame, following blob references. */
export function resolvedFrameBytes(archive: Archive): number {
	let total = 0;
	for (const frame of archive.frames) {
		total += resolveFrameData(frame.data)?.bytes ?? 0;
	}
	return total;
}

/** Replace each frame's inline base64 with a blob reference (when enabled). */
export function externalizeArchive(archive: Archive, enabled: boolean): Archive {
	if (!enabled) return archive;
	return {
		...archive,
		frames: archive.frames.map(frame => ({
			...frame,
			data: isBlobReference(frame.data) ? frame.data : putFrame(frame.data),
		})),
	};
}

// ============================================================================
// Garbage collection
// ============================================================================

export interface BlobGcOptions {
	/** Blob directory; defaults to {@link blobDir}. */
	dir?: string;
	/** Extra session roots to scan for references (added to the defaults). */
	sessionRoots?: string[];
	/** Exact session files to scan (e.g. the current transcript). */
	exactSessionFiles?: string[];
	now?: number;
	writeGraceMs?: number;
	retainMs?: number;
	/** Report what would be deleted without deleting. */
	dryRun?: boolean;
}

export interface BlobGcResult {
	/** Unreferenced, past-retention blobs considered. */
	candidates: number;
	/** Distinct hashes referenced by scanned transcripts. */
	referenced: number;
	deleted: number;
	bytes: number;
	stagingDeleted: number;
	errors: string[];
}

/** Roots scanned for blob references by default. */
function defaultSessionRoots(): string[] {
	const roots = [path.join(getAgentDir(), "sessions")];
	const override = process.env.PI_CODING_AGENT_SESSION_DIR;
	if (override) roots.push(override);
	return roots;
}

async function walkJsonl(root: string, out: string[]): Promise<void> {
	let entries: fs.Dirent[];
	try {
		entries = await fsp.readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) await walkJsonl(full, out);
		else if (entry.isFile() && entry.name.includes(".jsonl")) out.push(full);
	}
}

async function collectReferencedHashes(roots: string[], exactFiles: string[]): Promise<Set<string>> {
	const files = new Set<string>();
	for (const root of roots) {
		const found: string[] = [];
		await walkJsonl(root, found);
		for (const file of found) files.add(file);
	}
	for (const file of exactFiles) files.add(file);

	const hashes = new Set<string>();
	for (const file of files) {
		let text: string;
		try {
			text = await fsp.readFile(file, "utf8");
		} catch {
			continue;
		}
		// Raw-text matching: a recoverable malformed record can still own blobs.
		for (const match of text.matchAll(BLOB_REF_RE)) {
			const hash = match[1]?.toLowerCase();
			if (hash && HASH_RE.test(hash)) hashes.add(hash);
		}
	}
	return hashes;
}

/** Number of stored blobs and their total size, for status display. */
export function blobStats(dir: string = blobDir()): { files: number; bytes: number } {
	let files = 0;
	let bytes = 0;
	try {
		for (const entry of fs.readdirSync(dir)) {
			if (!HASH_RE.test(entry)) continue;
			try {
				const stat = fs.statSync(path.join(dir, entry));
				if (stat.isFile()) {
					files++;
					bytes += stat.size;
				}
			} catch {
				// Raced with a sweep.
			}
		}
	} catch {
		// No store yet.
	}
	return { files, bytes };
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Sweep the blob store: delete staging temps and unreferenced blobs older than
 * the retention window. A blob is referenced when any scanned transcript
 * contains its `blob:sha256:` reference. Blobs younger than the write grace
 * are never deleted (their reference may not be persisted yet), and a blob
 * whose mtime moved between the candidate scan and deletion is kept (a `put`
 * reused it mid-sweep).
 */
export async function gcBlobs(options: BlobGcOptions = {}): Promise<BlobGcResult> {
	const dir = options.dir ?? blobDir();
	const now = options.now ?? Date.now();
	const writeGrace = options.writeGraceMs ?? BLOB_WRITE_GRACE_MS;
	const retain = options.retainMs ?? BLOB_DEFAULT_RETAIN_MS;
	const dryRun = options.dryRun === true;
	const result: BlobGcResult = {
		candidates: 0,
		referenced: 0,
		deleted: 0,
		bytes: 0,
		stagingDeleted: 0,
		errors: [],
	};

	let entries: string[];
	try {
		entries = await fsp.readdir(dir);
	} catch {
		return result;
	}

	const candidates: { file: string; hash: string; mtimeMs: number }[] = [];
	for (const entry of entries) {
		const file = path.join(dir, entry);
		let stat: fs.Stats;
		try {
			stat = await fsp.stat(file);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;

		if (STAGING_RE.test(entry)) {
			if (stat.mtimeMs < now - writeGrace) {
				result.stagingDeleted++;
				if (!dryRun) {
					try {
						await fsp.unlink(file);
					} catch (error) {
						result.errors.push(`${file}: ${String(error)}`);
					}
				}
			}
			continue;
		}

		if (!HASH_RE.test(entry)) continue;
		if (stat.mtimeMs >= now - retain) continue; // Inside retention window.
		candidates.push({ file, hash: entry, mtimeMs: stat.mtimeMs });
	}
	result.candidates = candidates.length;
	if (candidates.length === 0) return result;

	const referenced = await collectReferencedHashes(
		[...defaultSessionRoots(), ...(options.sessionRoots ?? [])],
		options.exactSessionFiles ?? [],
	);
	result.referenced = referenced.size;

	for (const candidate of candidates) {
		if (referenced.has(candidate.hash)) continue;
		let stat: fs.Stats;
		try {
			stat = await fsp.stat(candidate.file);
		} catch {
			continue; // Already gone.
		}
		// Reused mid-sweep (mtime bumped) or now inside the grace: keep.
		if (stat.mtimeMs !== candidate.mtimeMs || stat.mtimeMs >= now - writeGrace) continue;
		result.deleted++;
		result.bytes += stat.size;
		if (dryRun) continue;
		try {
			await fsp.unlink(candidate.file);
		} catch (error) {
			result.errors.push(`${candidate.file}: ${String(error)}`);
		}
	}
	return result;
}

let sweepInFlight: Promise<BlobGcResult | undefined> | undefined;

/**
 * Run {@link gcBlobs} at most once per interval, tracked by a marker beside the
 * blob directory. Fire-and-forget from the extension; concurrent calls share
 * one sweep. Returns undefined when a recent sweep already ran.
 */
export function maybeAutoGc(
	options: BlobGcOptions & { intervalMs?: number } = {},
): Promise<BlobGcResult | undefined> {
	if (sweepInFlight) return sweepInFlight;
	sweepInFlight = (async () => {
		const marker = path.join(path.dirname(blobDir()), ".last-gc");
		const interval = options.intervalMs ?? BLOB_AUTO_GC_INTERVAL_MS;
		try {
			const stat = await fsp.stat(marker);
			if (Date.now() - stat.mtimeMs < interval) return undefined;
		} catch {
			// No marker yet.
		}
		const result = await gcBlobs(options);
		try {
			await fsp.mkdir(path.dirname(marker), { recursive: true });
			await fsp.writeFile(marker, String(Date.now()));
		} catch {
			// Marker is an optimization only.
		}
		return result;
	})().finally(() => {
		sweepInFlight = undefined;
	});
	return sweepInFlight;
}
