/**
 * Configuration layer (plan phase 1).
 *
 * Loads `arcane.json` from the first location that has one, resolves the API
 * key (literal / `$ENV_VAR` / `!command`), and can write the resolved
 * environment ID back so later sessions skip the picker.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SyncTargetType } from "./types.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_HOST = "https://arcane.hajek.click";

/** Host port every deployed container is published on, unless overridden. */
export const DEFAULT_HOST_PORT = "5553";

/** Container port the default mapping targets. */
export const DEFAULT_CONTAINER_PORT = "80";

/** Public hostname suffix the deployed containers are reachable under. */
export const PUBLIC_DOMAIN = "hajek.click";

/**
 * Hostname prefix the routing vhost matches: `pi-<hostPort>.hajek.click`.
 * See `nginx/pi-arcane.conf` and the note on `publicUrlForPort`.
 */
export const PUBLIC_HOST_PREFIX = "pi-";

export interface ArcaneDefaults {
	autoSync?: boolean;
	syncInterval?: number;
	composePath?: string;
	targetType?: SyncTargetType;
	projectName?: string;
	syncName?: string;
	/** `"HOST:CONTAINER"`, e.g. `"8080:80"`. Defaults to `"5553:80"`. */
	portMapping?: string;
}

/** Shape of `arcane.json` on disk, before any interpolation. */
export interface RawArcaneConfig {
	host?: string;
	apiKey?: string;
	environmentId?: string;
	defaults?: ArcaneDefaults;
}

/** Fully resolved config used by the rest of the extension. */
export interface ArcaneConfig {
	/** Base URL without the trailing `/api`, e.g. `https://arcane.hajek.click`. */
	host: string;
	apiKey: string;
	environmentId?: string;
	defaults: ArcaneDefaults;
	/** File the config came from, or `undefined` when built from the environment. */
	sourcePath?: string;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/**
 * Candidate config paths in resolution order: project-local `.pi/`, then
 * project root, then the global agent directory.
 */
export function configSearchPaths(cwd: string): string[] {
	return [
		join(cwd, CONFIG_DIR_NAME, "arcane.json"),
		join(cwd, "arcane.json"),
		join(getAgentDir() ?? join(homedir(), ".pi", "agent"), "arcane.json"),
	];
}

/** Path a fresh config is written to by `/arcane-setup`. */
export function defaultConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "arcane.json");
}

async function readJsonIfExists(path: string): Promise<RawArcaneConfig | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw new ConfigError(`Failed to read ${path}: ${(error as Error).message}`);
	}
	try {
		return JSON.parse(text) as RawArcaneConfig;
	} catch (error) {
		throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
	}
}

/**
 * Resolve a secret the same way pi resolves a provider `apiKey`:
 * a leading `!` runs a command, `$VAR` / `${VAR}` interpolate the environment,
 * `$$` escapes a literal `$`, and `$!` escapes a leading `!`.
 */
export async function resolveSecret(raw: string, label = "apiKey"): Promise<string> {
	const value = raw.trim();
	if (value.length === 0) throw new ConfigError(`${label} is empty`);

	if (value.startsWith("$!")) return value.slice(1);

	if (value.startsWith("!")) {
		const command = value.slice(1).trim();
		if (!command) throw new ConfigError(`${label} has an empty '!command'`);
		try {
			const shell = process.platform === "win32" ? "cmd" : "sh";
			const args = process.platform === "win32" ? ["/c", command] : ["-c", command];
			const { stdout } = await execFileAsync(shell, args, {
				timeout: 30_000,
				maxBuffer: 1024 * 1024,
			});
			const out = stdout.trim();
			if (!out) throw new ConfigError(`${label} command produced no output: ${command}`);
			return out;
		} catch (error) {
			if (error instanceof ConfigError) throw error;
			throw new ConfigError(`${label} command failed: ${(error as Error).message}`);
		}
	}

	// Interpolate $VAR / ${VAR}; $$ is a literal $.
	let out = "";
	let i = 0;
	const missing: string[] = [];
	while (i < value.length) {
		const ch = value[i];
		if (ch !== "$") {
			out += ch;
			i += 1;
			continue;
		}
		const next = value[i + 1];
		if (next === "$") {
			out += "$";
			i += 2;
			continue;
		}
		if (next === "{") {
			const end = value.indexOf("}", i + 2);
			if (end === -1) {
				out += value.slice(i);
				break;
			}
			const name = value.slice(i + 2, end);
			const resolved = process.env[name];
			if (resolved === undefined) missing.push(name);
			out += resolved ?? "";
			i = end + 1;
			continue;
		}
		const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(i + 1));
		if (!match) {
			out += ch;
			i += 1;
			continue;
		}
		const name = match[0];
		const resolved = process.env[name];
		if (resolved === undefined) missing.push(name);
		out += resolved ?? "";
		i += 1 + name.length;
	}

	if (missing.length > 0) {
		throw new ConfigError(
			`${label} references unset environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
		);
	}
	if (!out) throw new ConfigError(`${label} resolved to an empty string`);
	return out;
}

/** Strip any trailing slash and a trailing `/api` so callers can append `/api`. */
export function normalizeHost(host: string): string {
	let value = host.trim().replace(/\/+$/, "");
	if (value.toLowerCase().endsWith("/api")) value = value.slice(0, -4);
	return value;
}

/**
 * Find and resolve the config. Returns `undefined` when there is nothing to
 * work with at all (no file anywhere and no `ARCANE_API_KEY`), so callers can
 * point the user at `/arcane-setup`.
 */
export async function loadConfig(cwd: string): Promise<ArcaneConfig | undefined> {
	for (const path of configSearchPaths(cwd)) {
		const raw = await readJsonIfExists(path);
		if (!raw) continue;

		const apiKeyRaw = raw.apiKey ?? process.env.ARCANE_API_KEY;
		if (!apiKeyRaw) {
			throw new ConfigError(
				`${path} has no "apiKey" and ARCANE_API_KEY is not set. Run /arcane-setup.`,
			);
		}
		return {
			host: normalizeHost(raw.host ?? DEFAULT_HOST),
			apiKey: await resolveSecret(apiKeyRaw),
			environmentId: raw.environmentId,
			defaults: raw.defaults ?? {},
			sourcePath: path,
		};
	}

	// No config file: fall back to a bare ARCANE_API_KEY so the extension works
	// with zero setup.
	if (process.env.ARCANE_API_KEY) {
		return {
			host: normalizeHost(process.env.ARCANE_HOST ?? DEFAULT_HOST),
			apiKey: process.env.ARCANE_API_KEY,
			environmentId: process.env.ARCANE_ENVIRONMENT_ID,
			defaults: {},
		};
	}

	return undefined;
}

/**
 * Merge `patch` into the config file at `path` (creating it if needed),
 * preserving anything already there. Used to persist the picked environment ID.
 */
export async function writeConfigPatch(
	path: string,
	patch: Partial<RawArcaneConfig>,
): Promise<void> {
	const existing = (await readJsonIfExists(path)) ?? {};
	const merged: RawArcaneConfig = {
		...existing,
		...patch,
		defaults: { ...(existing.defaults ?? {}), ...(patch.defaults ?? {}) },
	};
	if (Object.keys(merged.defaults ?? {}).length === 0) delete merged.defaults;

	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

/**
 * Parse a `"HOST:CONTAINER"` mapping. Accepts a bare host port (`"8080"`),
 * which targets the default container port.
 */
export function parsePortMapping(mapping: string): { host: string; container: string } {
	const parts = mapping.trim().split(":").filter(Boolean);
	if (parts.length === 1) return { host: parts[0], container: DEFAULT_CONTAINER_PORT };
	if (parts.length >= 2) return { host: parts[parts.length - 2], container: parts[parts.length - 1] };
	throw new ConfigError(`Invalid port mapping: ${mapping}`);
}
