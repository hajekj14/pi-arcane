/**
 * Pre-pulling base images before a build.
 *
 * Arcane's BuildKit integration runs builds without an attached client session,
 * so BuildKit cannot reach a registry itself: resolving any image that is not
 * already in the host's image store fails with
 *
 *   failed to resolve source metadata for docker.io/library/nginx:1.27-alpine:
 *   no active sessions
 *
 * Verified against arcane.hajek.click on 2026-08-14: `FROM nginx:alpine` (present
 * locally) builds fine, `FROM nginx:1.27-alpine` (absent) fails; pulling it first
 * through `POST /images/pull` makes the identical build succeed. `pull: true` on
 * the build request does not help, and the `provider` field rejects every value
 * tried ("unknown build provider"). It affects the compose path too, where the
 * build happens during `up`.
 *
 * So every base image a Dockerfile references is pulled through Arcane first.
 * Pulls use Arcane's own registry credentials, which is also what makes private
 * base images work at all.
 */

import type { ArcaneClient } from "./client.ts";

/** BuildKit's marker for "no base image", never pulled. */
const SCRATCH = "scratch";

export interface BaseImageReport {
	/** Images that had to be fetched. */
	pulled: string[];
	/** Images already on the host. */
	present: string[];
	/** Images that could not be fetched, with the reason. */
	failed: Array<{ image: string; error: string }>;
}

/**
 * Every external image a Dockerfile depends on: `FROM` targets plus
 * `COPY --from=` / `RUN --mount=from=` sources.
 *
 * Stage names declared by `AS` are tracked so later references to them are not
 * mistaken for registry images, and `ARG`s seen before the first `FROM` are
 * interpolated the way BuildKit does.
 */
export function parseBaseImages(
	dockerfile: string,
	buildArgs: Record<string, string> = {},
): string[] {
	const args = new Map<string, string>(Object.entries(buildArgs));
	const stages = new Set<string>();
	const images: string[] = [];

	// Join continuation lines so a wrapped FROM/COPY is still one instruction.
	const text = dockerfile.replace(/\\[ \t]*\r?\n/g, " ");

	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;

		const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/i.exec(line);
		if (arg) {
			// A declared-but-unset ARG keeps whatever the caller passed.
			if (!args.has(arg[1])) args.set(arg[1], stripQuotes(arg[2] ?? ""));
			continue;
		}

		const from = /^FROM\s+(.*)$/i.exec(line);
		if (from) {
			const parts = from[1].trim().split(/\s+/);
			// Drop flags such as --platform=linux/amd64.
			const positional = parts.filter((p) => !p.startsWith("--"));
			const image = expand(positional[0] ?? "", args);

			const asIndex = parts.findIndex((p) => /^AS$/i.test(p));
			if (asIndex !== -1 && parts[asIndex + 1]) stages.add(parts[asIndex + 1].toLowerCase());

			if (isExternalImage(image, stages)) images.push(image);
			continue;
		}

		// COPY --from=<stage|image>, and RUN --mount=...,from=<stage|image>
		for (const match of line.matchAll(/--(?:from|mount=[^\s]*?\bfrom)=([^\s,]+)/gi)) {
			const source = expand(match[1], args);
			if (isExternalImage(source, stages)) images.push(source);
		}
	}

	return [...new Set(images)];
}

/** `${VAR}` and `$VAR`, with unknown variables left as-is. */
function expand(value: string, args: Map<string, string>): string {
	return value
		.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g, (whole, name, fallback) => {
			const resolved = args.get(name);
			if (resolved) return resolved;
			return fallback !== undefined ? fallback : whole;
		})
		.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name) => args.get(name) ?? whole);
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && /^["'].*["']$/.test(trimmed)) return trimmed.slice(1, -1);
	return trimmed;
}

function isExternalImage(value: string, stages: Set<string>): boolean {
	if (!value) return false;
	if (value.toLowerCase() === SCRATCH) return false;
	// A numeric --from is a stage index, not an image.
	if (/^\d+$/.test(value)) return false;
	if (stages.has(value.toLowerCase())) return false;
	// An unresolved ARG cannot be pulled; let the build report it.
	if (value.includes("$")) return false;
	return true;
}

/**
 * Make sure every image in `images` is on the host before a build starts.
 *
 * Failures are reported rather than thrown: a pull can fail for reasons the
 * build might survive (an image present under a different tag, a registry
 * hiccup), and the build's own error is more informative than a guess here.
 */
export async function ensureBaseImages(
	client: ArcaneClient,
	environmentId: string,
	images: string[],
	options: { signal?: AbortSignal; onProgress?: (message: string) => void } = {},
): Promise<BaseImageReport> {
	const report: BaseImageReport = { pulled: [], present: [], failed: [] };
	if (images.length === 0) return report;

	let local: Set<string>;
	try {
		local = await listLocalTags(client, environmentId, options.signal);
	} catch {
		// Without the listing, pull everything: a redundant pull is cheap next to
		// a build that fails on "no active sessions".
		local = new Set();
	}

	for (const image of images) {
		if (local.has(normalizeTag(image))) {
			report.present.push(image);
			continue;
		}
		options.onProgress?.(`Pulling base image ${image} (Arcane's builder cannot fetch it itself)...`);
		try {
			await client.pullImage(environmentId, image, options.signal);
			report.pulled.push(image);
		} catch (error) {
			report.failed.push({ image, error: (error as Error).message });
		}
	}

	return report;
}

async function listLocalTags(
	client: ArcaneClient,
	environmentId: string,
	signal?: AbortSignal,
): Promise<Set<string>> {
	const images = await client.listImages(environmentId, signal);
	const tags = new Set<string>();
	for (const image of images) {
		for (const tag of image.repoTags ?? []) tags.add(normalizeTag(tag));
	}
	return tags;
}

/** `nginx` and `docker.io/library/nginx:latest` are the same image. */
function normalizeTag(reference: string): string {
	let value = reference.trim();
	value = value.replace(/^docker\.io\//, "").replace(/^library\//, "");
	// A digest pins the image exactly; leave it alone.
	if (value.includes("@")) return value;
	const lastColon = value.lastIndexOf(":");
	const hasTag = lastColon > value.lastIndexOf("/");
	return hasTag ? value : `${value}:latest`;
}

/**
 * Explain the raw BuildKit failure, which names neither the cause nor the fix.
 * Returns undefined when the output is some other error.
 */
export function explainBuildFailure(output: string, report?: BaseImageReport): string | undefined {
	if (!/no active sessions/i.test(output)) return undefined;

	const lines = [
		"Arcane's builder has no registry session, so it can only build FROM images already on the host.",
	];
	if (report?.failed.length) {
		lines.push(
			`Pre-pulling failed for: ${report.failed.map((f) => `${f.image} (${f.error})`).join("; ")}`,
		);
	} else {
		lines.push(
			"The base image was not pre-pulled — check the FROM line for a variable or an unusual reference.",
		);
	}
	lines.push(
		"Workaround: pull it first, e.g. POST /environments/<env>/images/pull, then rebuild.",
	);
	return lines.join("\n");
}
