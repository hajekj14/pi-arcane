/**
 * Compose/Dockerfile detection and port handling (plan phases 6.2, 6.3, 9.5).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import yaml from "js-yaml";
import { DEFAULT_CONTAINER_PORT, DEFAULT_HOST_PORT, parsePortMapping } from "./config.ts";
import type { SyncTargetType } from "./types.ts";

/** Compose filenames, in the order Docker Compose itself resolves them. */
const COMPOSE_FILENAMES = [
	"compose.yaml",
	"compose.yml",
	"docker-compose.yaml",
	"docker-compose.yml",
];

export interface DetectedTarget {
	targetType: SyncTargetType;
	/** Repo-root-relative, POSIX-separated path to the compose file, if any. */
	composePath?: string;
	/** Repo-root-relative, POSIX-separated path to the Dockerfile, if any. */
	dockerfilePath?: string;
	/** Directory the files were found in, relative to the repo root. */
	contextDir: string;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function toPosix(value: string): string {
	return value.split(sep).join(posix.sep);
}

/**
 * Look for a compose file, then a Dockerfile, in `searchDir`.
 *
 * `targetType` is `"compose"` when a compose file exists and `"container"`
 * when only a Dockerfile does — a Dockerfile-only repo still deploys as a
 * generated one-service compose project, since that is the only project shape
 * Arcane's GitOps syncs understand.
 */
export async function detectTarget(
	repoRoot: string,
	searchDir: string,
): Promise<DetectedTarget | undefined> {
	const contextDir = toPosix(relative(repoRoot, searchDir)) || ".";

	for (const name of COMPOSE_FILENAMES) {
		if (await exists(join(searchDir, name))) {
			const dockerfile = await findDockerfile(searchDir);
			return {
				targetType: "compose",
				composePath: joinRepoPath(contextDir, name),
				dockerfilePath: dockerfile ? joinRepoPath(contextDir, dockerfile) : undefined,
				contextDir,
			};
		}
	}

	const dockerfile = await findDockerfile(searchDir);
	if (dockerfile) {
		return {
			targetType: "container",
			dockerfilePath: joinRepoPath(contextDir, dockerfile),
			contextDir,
		};
	}

	return undefined;
}

function joinRepoPath(dir: string, name: string): string {
	return dir === "." ? name : posix.join(dir, name);
}

/** Prefer a plain `Dockerfile`, then any `Dockerfile*` variant. */
async function findDockerfile(dir: string): Promise<string | undefined> {
	if (await exists(join(dir, "Dockerfile"))) return "Dockerfile";
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		const candidate = entries
			.filter((e) => e.isFile() && /^Dockerfile/i.test(e.name))
			.map((e) => e.name)
			.sort()[0];
		return candidate;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Compose document handling
// ---------------------------------------------------------------------------

interface ComposeDocument {
	services?: Record<string, ComposeService | null>;
	[key: string]: unknown;
}

interface ComposeService {
	build?: unknown;
	image?: string;
	ports?: unknown[];
	environment?: unknown;
	container_name?: string;
	[key: string]: unknown;
}

export interface PublishedPort {
	host: string;
	container: string;
}

export interface ComposeServiceInfo {
	name: string;
	hasBuild: boolean;
	image?: string;
	publishedPorts: PublishedPort[];
	containerName?: string;
}

export interface ComposeInfo {
	services: ComposeServiceInfo[];
	/** The service a single-endpoint deployment should be reached through. */
	primaryService?: ComposeServiceInfo;
}

export class ComposeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ComposeError";
	}
}

function parseCompose(content: string): ComposeDocument {
	let doc: unknown;
	try {
		doc = yaml.load(content);
	} catch (error) {
		throw new ComposeError(`Compose file is not valid YAML: ${(error as Error).message}`);
	}
	if (doc === null || doc === undefined) return {};
	if (typeof doc !== "object") throw new ComposeError("Compose file is not a YAML mapping");
	return doc as ComposeDocument;
}

/** Read one `ports:` entry in either short (`"8080:80"`) or long (mapping) form. */
function readPortEntry(entry: unknown): PublishedPort | undefined {
	if (typeof entry === "number") {
		// A bare container port is not published to the host.
		return undefined;
	}
	if (typeof entry === "string") {
		// Forms: "80", "8080:80", "127.0.0.1:8080:80", any with "/tcp".
		const [spec] = entry.split("/");
		const parts = spec.split(":");
		if (parts.length < 2) return undefined;
		return { host: parts[parts.length - 2], container: parts[parts.length - 1] };
	}
	if (entry && typeof entry === "object") {
		const long = entry as { published?: unknown; target?: unknown };
		if (long.published === undefined || long.target === undefined) return undefined;
		return { host: String(long.published), container: String(long.target) };
	}
	return undefined;
}

export function readComposeInfo(content: string): ComposeInfo {
	const doc = parseCompose(content);
	const services: ComposeServiceInfo[] = [];

	for (const [name, raw] of Object.entries(doc.services ?? {})) {
		const service = (raw ?? {}) as ComposeService;
		const publishedPorts: PublishedPort[] = [];
		for (const entry of service.ports ?? []) {
			const port = readPortEntry(entry);
			if (port) publishedPorts.push(port);
		}
		services.push({
			name,
			hasBuild: service.build !== undefined,
			image: typeof service.image === "string" ? service.image : undefined,
			publishedPorts,
			containerName:
				typeof service.container_name === "string" ? service.container_name : undefined,
		});
	}

	// Whatever is publicly reachable wins; then whatever is built here; then first.
	const primaryService =
		services.find((s) => s.publishedPorts.length > 0) ??
		services.find((s) => s.hasBuild) ??
		services[0];

	return { services, primaryService };
}

export interface ComposePatchResult {
	content: string;
	changed: boolean;
	/** What the primary service ends up published on, if anything. */
	effectivePort?: PublishedPort;
	/** Service the patch applies to. */
	serviceName?: string;
	/** The primary service's container name once deployed, if it is fixed. */
	containerName?: string;
	/** Human-readable notes about what was and was not changed. */
	notes: string[];
}

export interface PreparePatchOptions {
	/** `"HOST:CONTAINER"`. Defaults to `5553:80`. */
	portMapping?: string;
	/**
	 * Container name to pin on the primary service so the host's nginx vhost
	 * can route to it. Skipped when the service already names itself.
	 */
	routableName?: string;
}

/**
 * Prepare a compose document for deployment (plan 9.5).
 *
 * Two things are filled in, and only when they are absent — a repo that
 * configures its own ports or container names is deliberate, and overriding it
 * would break the deployment it asked for:
 *
 * - a published host port, so the service is reachable at all;
 * - a fixed `container_name`, so the host's `t-*.hajek.click` vhost can find
 *   it. Compose's generated names (`myapp-web-1`) do not match that vhost's
 *   `t-[a-z0-9]+` pattern, so without this the deployment runs but no URL
 *   resolves.
 *
 * The file in git is never touched; this patches the copy Arcane holds.
 */
export function prepareCompose(
	content: string,
	options: PreparePatchOptions = {},
): ComposePatchResult {
	const { host, container } = parsePortMapping(
		options.portMapping ?? `${DEFAULT_HOST_PORT}:${DEFAULT_CONTAINER_PORT}`,
	);
	const doc = parseCompose(content);
	const info = readComposeInfo(content);
	const primary = info.primaryService;
	const notes: string[] = [];

	if (!primary) {
		return { content, changed: false, notes: ["compose file declares no services"] };
	}

	const services = (doc.services ?? {}) as Record<string, ComposeService | null>;
	const target = (services[primary.name] ?? {}) as ComposeService;
	let changed = false;

	// --- ports ---------------------------------------------------------------
	let effectivePort: PublishedPort | undefined;
	const alreadyOnHostPort = primary.publishedPorts.find((p) => p.host === host);

	if (alreadyOnHostPort) {
		effectivePort = alreadyOnHostPort;
		notes.push(`service "${primary.name}" already publishes ${host}:${alreadyOnHostPort.container}`);
	} else if (primary.publishedPorts.length > 0) {
		effectivePort = primary.publishedPorts[0];
		notes.push(
			`service "${primary.name}" publishes ${primary.publishedPorts
				.map((p) => `${p.host}:${p.container}`)
				.join(", ")} — left as-is`,
		);
	} else {
		target.ports = [...(target.ports ?? []), `${host}:${container}`];
		effectivePort = { host, container };
		changed = true;
		notes.push(`added ${host}:${container} to service "${primary.name}" (it published nothing)`);
	}

	// --- container name ------------------------------------------------------
	let containerName = primary.containerName;
	if (containerName) {
		notes.push(`service "${primary.name}" sets container_name "${containerName}" — left as-is`);
	} else if (options.routableName) {
		target.container_name = options.routableName;
		containerName = options.routableName;
		changed = true;
		notes.push(`pinned container_name "${options.routableName}" so the public URL resolves`);
	}

	if (!changed) return { content, changed, effectivePort, serviceName: primary.name, containerName, notes };

	services[primary.name] = target;
	doc.services = services;

	return {
		content: yaml.dump(doc, { lineWidth: 120, noRefs: true }),
		changed: true,
		effectivePort,
		serviceName: primary.name,
		containerName,
		notes,
	};
}

export interface GenerateComposeOptions {
	serviceName: string;
	/** Build context, relative to the compose file. */
	context?: string;
	dockerfile?: string;
	image?: string;
	portMapping?: string;
	buildArgs?: Record<string, string>;
	env?: Record<string, string>;
	/** Fixed container name, so the host's `t-*` vhost can route to it. */
	containerName?: string;
}

/**
 * Build a one-service compose document for a repo that only has a Dockerfile
 * (plan 6.3). Arcane's project model is compose-based, so this is how a
 * "single container" deployment is expressed.
 */
export function generateCompose(options: GenerateComposeOptions): string {
	const { host, container } = parsePortMapping(
		options.portMapping ?? `${DEFAULT_HOST_PORT}:${DEFAULT_CONTAINER_PORT}`,
	);

	const service: ComposeService = {};
	if (options.image) {
		service.image = options.image;
	} else {
		const build: Record<string, unknown> = { context: options.context ?? "." };
		if (options.dockerfile) build.dockerfile = options.dockerfile;
		if (options.buildArgs && Object.keys(options.buildArgs).length > 0) {
			build.args = { ...options.buildArgs };
		}
		service.build = build;
	}

	service.ports = [`${host}:${container}`];
	service.restart = "unless-stopped";
	if (options.containerName) service.container_name = options.containerName;
	if (options.env && Object.keys(options.env).length > 0) {
		service.environment = { ...options.env };
	}

	return yaml.dump({ services: { [options.serviceName]: service } }, {
		lineWidth: 120,
		noRefs: true,
	});
}

/** Read a compose file from disk, returning undefined when it is missing. */
export async function readComposeFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}
