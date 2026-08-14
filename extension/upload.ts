/**
 * Uploading the working tree to Arcane (plan-upload.md §3, §7).
 *
 * Arcane builds from a directory on its own filesystem, so a deploy pushes the
 * local tree into the upload sidecar, which writes it into a volume the Arcane
 * container has mounted. Nothing here touches git remotes: what is on disk is
 * what gets built, uncommitted edits included.
 *
 * The sidecar has no DELETE, so files that leave the working tree are pruned
 * through Arcane's volume-browse API instead.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { ArcaneClient } from "./client.ts";
import type { UploadConfig } from "./config.ts";
import { sanitizeName } from "./git.ts";

const execFileAsync = promisify(execFile);

/** Uploads run concurrently; measured ~4x faster than serial at this width. */
const UPLOAD_CONCURRENCY = 8;

/** Directories never worth uploading, used only outside a git repo. */
const ALWAYS_IGNORED = new Set([
	".git",
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	"dist",
	"build",
	"target",
	".next",
	".nuxt",
	".cache",
	".pi",
]);

const MANIFEST_VERSION = 1;

export class UploadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UploadError";
	}
}

export interface SelectedFile {
	/** POSIX path relative to the context root. */
	path: string;
	absolutePath: string;
	size: number;
}

export interface UploadManifest {
	version: number;
	updatedAt: string;
	files: Record<string, { size: number; sha256: string }>;
}

export interface UploadResult {
	/** Absolute path of the context as the Arcane container sees it. */
	contextPath: string;
	uploaded: number;
	deleted: number;
	unchanged: number;
	bytes: number;
	durationMs: number;
	/** Non-fatal problems worth reporting, e.g. stale files that could not be pruned. */
	warnings: string[];
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * Stable per-checkout slug: the directory name plus a hash of its absolute
 * path, so two checkouts of the same repo do not overwrite each other's context.
 */
export function contextSlug(root: string, name?: string): string {
	const base = sanitizeName(name ?? root.split(/[\\/]/).filter(Boolean).pop() ?? "app");
	const hash = createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 6);
	return `${base}-${hash}`;
}

// ---------------------------------------------------------------------------
// File selection
// ---------------------------------------------------------------------------

/**
 * List the files to upload.
 *
 * Inside a git repo this is `git ls-files -co --exclude-standard`: tracked
 * files plus untracked ones that are not ignored, minus deletions. That gives
 * .gitignore handling for free and, unlike `git archive`, includes uncommitted
 * work — the whole point of building from the working tree. Outside a repo it
 * falls back to a directory walk with a fixed ignore list.
 */
export async function collectFiles(
	root: string,
	options: { includeUntracked?: boolean; signal?: AbortSignal } = {},
): Promise<SelectedFile[]> {
	const names = (await gitListFiles(root, options)) ?? (await walkDirectory(root));

	const dockerignore = await readDockerignore(root);
	const filtered = dockerignore ? names.filter((name) => !dockerignore(name)) : names;

	const files: SelectedFile[] = [];
	for (const name of filtered) {
		const absolutePath = join(root, name);
		try {
			const info = await stat(absolutePath);
			// stat() follows symlinks, so a link pointing outside the tree resolves
			// to its target and is uploaded as a plain file — which is what a build
			// context needs anyway. Directories and sockets are skipped.
			if (!info.isFile()) continue;
			files.push({ path: name, absolutePath, size: info.size });
		} catch {
			// Raced with a delete, or a dangling symlink: nothing to upload.
		}
	}
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function gitListFiles(
	root: string,
	options: { includeUntracked?: boolean; signal?: AbortSignal },
): Promise<string[] | undefined> {
	const args = ["ls-files", "-z", "--exclude-standard", "-c"];
	if (options.includeUntracked !== false) args.push("-o");

	let listed: string;
	let deleted: string;
	try {
		[listed, deleted] = await Promise.all([
			gitOutput(root, args, options.signal),
			gitOutput(root, ["ls-files", "-z", "--deleted"], options.signal),
		]);
	} catch {
		return undefined;
	}

	const gone = new Set(splitZ(deleted));
	return splitZ(listed).filter((name) => !gone.has(name));
}

async function gitOutput(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		signal,
		timeout: 60_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout;
}

function splitZ(value: string): string[] {
	return value.split("\0").filter(Boolean);
}

async function walkDirectory(root: string): Promise<string[]> {
	const out: string[] = [];

	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (ALWAYS_IGNORED.has(entry.name)) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile()) {
				out.push(toPosix(relative(root, full)));
			}
		}
	}

	await walk(root);
	return out;
}

function toPosix(value: string): string {
	return value.split(sep).join(posix.sep);
}

/**
 * Compile `.dockerignore` into a predicate.
 *
 * Deliberately a subset of BuildKit's matcher: `#` comments, `!` re-includes,
 * `*`/`?` globs and `**`. A pattern without a slash matches at any depth, the
 * way Docker treats a bare name. Anything more exotic simply uploads more than
 * strictly needed, which is safe.
 */
async function readDockerignore(root: string): Promise<((path: string) => boolean) | undefined> {
	let content: string;
	try {
		content = await readFile(join(root, ".dockerignore"), "utf8");
	} catch {
		return undefined;
	}

	const rules: Array<{ negated: boolean; re: RegExp }> = [];
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const negated = line.startsWith("!");
		const pattern = (negated ? line.slice(1) : line).replace(/^\.\//, "").replace(/\/+$/, "");
		if (!pattern) continue;
		rules.push({ negated, re: patternToRegExp(pattern) });
	}
	if (rules.length === 0) return undefined;

	return (path: string) => {
		let ignored = false;
		for (const rule of rules) {
			if (rule.re.test(path)) ignored = !rule.negated;
		}
		// .dockerignore never excludes the Dockerfile itself from being readable.
		if (ignored && /^Dockerfile[^/]*$/i.test(path)) return false;
		return ignored;
	};
}

function patternToRegExp(pattern: string): RegExp {
	const anchored = pattern.includes("/");
	let out = "";
	for (let i = 0; i < pattern.length; i += 1) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				out += ".*";
				i += 1;
				if (pattern[i + 1] === "/") i += 1;
			} else {
				out += "[^/]*";
			}
		} else if (ch === "?") {
			out += "[^/]";
		} else {
			out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	// Match the entry itself and anything beneath it.
	const body = anchored ? `^${out}` : `(^|/)${out}`;
	return new RegExp(`${body}($|/)`);
}

// ---------------------------------------------------------------------------
// Sidecar transport
// ---------------------------------------------------------------------------

class SidecarClient {
	// Written out rather than a constructor parameter property: pi runs these
	// files through Node's strip-only TypeScript support, which rejects those.
	private readonly config: UploadConfig;

	constructor(config: UploadConfig) {
		this.config = config;
	}

	private url(path: string, query?: Record<string, string>): string {
		const url = new URL(`${this.config.url}/files/${path.replace(/^\/+/, "")}`);
		for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
		return url.toString();
	}

	async put(path: string, body: Buffer, signal?: AbortSignal): Promise<void> {
		// The server reads the body as a multipart form field named "file", not as
		// a raw PUT body, and refuses to replace an existing file with 409 unless
		// overwrite is set.
		const form = new FormData();
		form.append("file", new Blob([new Uint8Array(body)]), path.split("/").pop() ?? "file");

		const response = await fetch(this.url(path, { overwrite: "true" }), {
			method: "PUT",
			headers: { Authorization: `Bearer ${this.config.token}` },
			body: form,
			signal,
		});
		if (!response.ok) {
			throw new UploadError(await describeFailure(response, `upload ${path}`, this.config));
		}
	}

	async getText(path: string, signal?: AbortSignal): Promise<string | undefined> {
		const response = await fetch(this.url(path), {
			headers: { Authorization: `Bearer ${this.config.token}` },
			signal,
		});
		if (response.status === 404) return undefined;
		if (!response.ok) {
			throw new UploadError(await describeFailure(response, `read ${path}`, this.config));
		}
		return await response.text();
	}
}

async function describeFailure(
	response: Response,
	action: string,
	config: UploadConfig,
): Promise<string> {
	const body = (await response.text().catch(() => "")).slice(0, 300);

	if (response.status === 401 || response.status === 403) {
		return `Upload server rejected the token (HTTP ${response.status}). Check upload.token in arcane.json — it defaults to the Arcane API key, which the sidecar must be configured with.`;
	}
	if (response.status === 413) {
		return `Upload server refused ${action}: the file is larger than the proxy allows (HTTP 413). Raise client_max_body_size on both nginx layers and -max_upload_size in the sidecar; the extension is configured for ${formatBytes(config.maxFileBytes)}.`;
	}
	if (response.status === 502 || response.status === 503 || response.status === 504) {
		return `Upload server at ${config.url} is not answering (HTTP ${response.status}). Is the pi-arcane-upload container running?`;
	}
	return `Failed to ${action}: HTTP ${response.status}${body ? ` ${body}` : ""}`;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncOptions {
	client: ArcaneClient;
	environmentId: string;
	config: UploadConfig;
	/** Directory whose contents become the build context. */
	root: string;
	slug: string;
	files: SelectedFile[];
	/** Ignore the previous manifest and re-upload everything. */
	refresh?: boolean;
	signal?: AbortSignal;
	onProgress?: (done: number, total: number) => void;
}

/**
 * Push `files` into `<slug>/ctx` and return where Arcane can find them.
 *
 * Only files whose size or hash changed are sent; the manifest recording those
 * hashes is written last, so an interrupted upload leaves a conservative record
 * that causes a re-upload next time rather than a silent under-upload. The
 * manifest lives beside `ctx/`, never inside it, so it cannot end up in the
 * build context or perturb BuildKit's cache key.
 */
export async function syncContext(options: SyncOptions): Promise<UploadResult> {
	const { client, environmentId, config, slug, files, signal, onProgress } = options;
	const started = Date.now();
	const warnings: string[] = [];

	const oversized = files.filter((f) => f.size > config.maxFileBytes);
	if (oversized.length > 0) {
		throw new UploadError(
			[
				`${oversized.length} file(s) exceed the ${formatBytes(config.maxFileBytes)} upload limit:`,
				...oversized.slice(0, 10).map((f) => `  ${f.path} (${formatBytes(f.size)})`),
				oversized.length > 10 ? `  ...and ${oversized.length - 10} more` : "",
				"Add them to .dockerignore, or raise both -max_upload_size in the sidecar and client_max_body_size in nginx.",
			]
				.filter(Boolean)
				.join("\n"),
		);
	}

	const sidecar = new SidecarClient(config);
	const manifestPath = `${slug}/manifest.json`;
	const previous = options.refresh ? undefined : await readManifest(sidecar, manifestPath, signal);

	// Hash everything first: the manifest must describe exactly what was sent.
	const hashed = new Map<string, { size: number; sha256: string; file: SelectedFile }>();
	for (const file of files) {
		const bytes = await readFile(file.absolutePath);
		hashed.set(file.path, {
			size: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			file,
		});
	}

	const changed = [...hashed.entries()].filter(([path, entry]) => {
		const before = previous?.files[path];
		return !before || before.sha256 !== entry.sha256 || before.size !== entry.size;
	});

	const removed = Object.keys(previous?.files ?? {}).filter((path) => !hashed.has(path));

	let bytes = 0;
	let done = 0;
	await runPool(changed, UPLOAD_CONCURRENCY, async ([path, entry]) => {
		const body = await readFile(entry.file.absolutePath);
		await sidecar.put(`${slug}/ctx/${path}`, body, signal);
		bytes += body.byteLength;
		done += 1;
		onProgress?.(done, changed.length);
	});

	if (removed.length > 0) {
		const pruned = await pruneFiles(client, environmentId, config, slug, removed, signal);
		if (pruned.error) warnings.push(pruned.error);
	}

	const manifest: UploadManifest = {
		version: MANIFEST_VERSION,
		updatedAt: new Date().toISOString(),
		files: Object.fromEntries(
			[...hashed.entries()].map(([path, entry]) => [path, { size: entry.size, sha256: entry.sha256 }]),
		),
	};
	await sidecar.put(manifestPath, Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8"), signal);

	return {
		contextPath: contextPathFor(config, slug),
		uploaded: changed.length,
		deleted: removed.length,
		unchanged: hashed.size - changed.length,
		bytes,
		durationMs: Date.now() - started,
		warnings,
	};
}

/** Absolute path of a slug's build context, as the Arcane container sees it. */
export function contextPathFor(config: UploadConfig, slug: string): string {
	return `${config.containerPath}/${slug}/ctx`;
}

async function readManifest(
	sidecar: SidecarClient,
	path: string,
	signal?: AbortSignal,
): Promise<UploadManifest | undefined> {
	let text: string | undefined;
	try {
		text = await sidecar.getText(path, signal);
	} catch {
		// An unreadable manifest is not fatal: re-uploading everything is correct,
		// just slower.
		return undefined;
	}
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text) as UploadManifest;
		if (parsed.version !== MANIFEST_VERSION || typeof parsed.files !== "object") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/**
 * Delete files that have left the working tree.
 *
 * Stale files matter: `COPY . .` would otherwise bake a deleted source file
 * into the image. The sidecar cannot delete, so this goes through Arcane's
 * volume API, which needs the volume backing the upload directory.
 */
async function pruneFiles(
	client: ArcaneClient,
	environmentId: string,
	config: UploadConfig,
	slug: string,
	paths: string[],
	signal?: AbortSignal,
): Promise<{ error?: string }> {
	let volume: ResolvedVolume | undefined;
	try {
		volume = await resolveVolume(client, environmentId, config, signal);
	} catch (error) {
		return { error: `Could not resolve the upload volume: ${(error as Error).message}` };
	}
	if (!volume) {
		return {
			error: `${paths.length} file(s) were removed locally but could not be deleted from the build context: no volume mounts ${config.containerPath} in the Arcane container. Set upload.volumeName in arcane.json, or the stale files stay in the context.`,
		};
	}

	const failures: string[] = [];
	for (const path of paths) {
		try {
			await client.deleteVolumePath(
				environmentId,
				volume.name,
				`${volume.relativeBase}/${slug}/ctx/${path}`,
				signal,
			);
		} catch (error) {
			failures.push(`${path}: ${(error as Error).message}`);
		}
	}

	if (failures.length > 0) {
		return {
			error: `Could not delete ${failures.length} stale file(s) from the build context: ${failures[0]}`,
		};
	}
	return {};
}

interface ResolvedVolume {
	name: string;
	/** `containerPath` expressed relative to the volume root, e.g. `/pi-arcane`. */
	relativeBase: string;
}

let cachedVolume: ResolvedVolume | undefined;

/**
 * Work out which volume holds `containerPath`.
 *
 * Rather than hardcoding `arcane_arcane-data:/app/data`, this reads the Arcane
 * container's own mounts and picks the volume whose destination is a prefix of
 * the upload path — so it keeps working if the deployment is laid out
 * differently.
 */
async function resolveVolume(
	client: ArcaneClient,
	environmentId: string,
	config: UploadConfig,
	signal?: AbortSignal,
): Promise<ResolvedVolume | undefined> {
	if (config.volumeName) {
		return { name: config.volumeName, relativeBase: "" };
	}
	if (cachedVolume) return cachedVolume;

	const containers = await client.listContainers(environmentId, signal);
	const arcane = containers.find((c) => /(^|\/)arcane/i.test(c.image ?? ""));
	if (!arcane) return undefined;

	const details = await client.getContainer(environmentId, arcane.id, signal);
	const candidates = (details.mounts ?? [])
		.filter((m) => m.type === "volume" && m.name)
		.filter((m) => config.containerPath === m.destination || config.containerPath.startsWith(`${m.destination}/`));

	// Longest destination wins, so a nested mount beats the parent volume.
	candidates.sort((a, b) => b.destination.length - a.destination.length);
	const mount = candidates[0];
	if (!mount?.name) return undefined;

	cachedVolume = {
		name: mount.name,
		relativeBase: config.containerPath.slice(mount.destination.length).replace(/\/+$/, ""),
	};
	return cachedVolume;
}

/** Forget the discovered volume; called when the session resets. */
export function resetUploadCache(): void {
	cachedVolume = undefined;
}

/**
 * Delete a whole uploaded context, used by teardown.
 * Returns the reason when it could not be removed.
 */
export async function removeContext(
	client: ArcaneClient,
	environmentId: string,
	config: UploadConfig,
	slug: string,
	signal?: AbortSignal,
): Promise<{ removed: boolean; reason?: string }> {
	let volume: ResolvedVolume | undefined;
	try {
		volume = await resolveVolume(client, environmentId, config, signal);
	} catch (error) {
		return { removed: false, reason: (error as Error).message };
	}
	if (!volume) return { removed: false, reason: "no volume mounts the upload directory" };

	try {
		await client.deleteVolumePath(
			environmentId,
			volume.name,
			`${volume.relativeBase}/${slug}`,
			signal,
		);
		return { removed: true };
	} catch (error) {
		return { removed: false, reason: (error as Error).message };
	}
}

/** List the slugs currently holding an uploaded context. */
export async function listContexts(
	client: ArcaneClient,
	environmentId: string,
	config: UploadConfig,
	signal?: AbortSignal,
): Promise<string[]> {
	const volume = await resolveVolume(client, environmentId, config, signal);
	if (!volume) return [];
	const entries = await client.listVolumeFiles(
		environmentId,
		volume.name,
		volume.relativeBase || "/",
		signal,
	);
	return entries.filter((e) => e.isDirectory).map((e) => e.name);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run `worker` over `items` with at most `width` in flight. */
async function runPool<T>(
	items: T[],
	width: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	const runners = Array.from({ length: Math.min(width, items.length) }, async () => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			await worker(items[index]);
		}
	});
	await Promise.all(runners);
}

export function formatBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
	return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
