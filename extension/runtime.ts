/**
 * Session-scoped runtime: config → client → environment.
 *
 * Everything is resolved lazily on first use and cached for the session
 * (plan 1.1, 1.3). Tools call `requireRuntime()`; it throws messages that read
 * well when handed straight back to the model.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ArcaneApiError, ArcaneClient } from "./client.ts";
import {
	ConfigError,
	PUBLIC_DOMAIN,
	PUBLIC_HOST_PREFIX,
	configSearchPaths,
	loadConfig,
	writeConfigPatch,
	type ArcaneConfig,
} from "./config.ts";
import type { Environment } from "./types.ts";

export interface ArcaneRuntime {
	config: ArcaneConfig;
	client: ArcaneClient;
	environmentId: string;
	environmentName?: string;
}

export class ArcaneSetupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArcaneSetupError";
	}
}

let cachedConfig: ArcaneConfig | undefined;
let cachedClient: ArcaneClient | undefined;
let cachedEnvironmentId: string | undefined;
let cachedEnvironmentName: string | undefined;

/** Drop all cached state. Call from `session_start` and after `/arcane-setup`. */
export function resetRuntime(): void {
	cachedConfig = undefined;
	cachedClient = undefined;
	cachedEnvironmentId = undefined;
	cachedEnvironmentName = undefined;
}

/** Load and cache the config, or throw a message pointing at `/arcane-setup`. */
export async function requireConfig(ctx: ExtensionContext): Promise<ArcaneConfig> {
	if (cachedConfig) return cachedConfig;

	let config: ArcaneConfig | undefined;
	try {
		config = await loadConfig(ctx.cwd);
	} catch (error) {
		if (error instanceof ConfigError) throw new ArcaneSetupError(error.message);
		throw error;
	}

	if (!config) {
		throw new ArcaneSetupError(
			[
				"No Arcane configuration found. Run /arcane-setup, set ARCANE_API_KEY, or create one of:",
				...configSearchPaths(ctx.cwd).map((p) => `  - ${p}`),
			].join("\n"),
		);
	}

	cachedConfig = config;
	return config;
}

export async function requireClient(ctx: ExtensionContext): Promise<ArcaneClient> {
	if (cachedClient) return cachedClient;
	const config = await requireConfig(ctx);
	cachedClient = new ArcaneClient(config.host, config.apiKey);
	return cachedClient;
}

/**
 * Resolve the target environment (plan 1.3): configured value wins, a single
 * environment auto-selects, several prompt the user, none is an error. The
 * choice is cached and written back to the config file when possible.
 */
export async function requireEnvironmentId(ctx: ExtensionContext): Promise<string> {
	if (cachedEnvironmentId) return cachedEnvironmentId;

	const config = await requireConfig(ctx);
	if (config.environmentId) {
		cachedEnvironmentId = config.environmentId;
		return cachedEnvironmentId;
	}

	const client = await requireClient(ctx);
	let environments: Environment[];
	try {
		environments = await client.listEnvironments(ctx.signal);
	} catch (error) {
		if (error instanceof ArcaneApiError && error.isAuthError) {
			throw new ArcaneSetupError(
				`Arcane rejected the API key (HTTP ${error.status}). Check apiKey in ${config.sourcePath ?? "ARCANE_API_KEY"} or run /arcane-setup.`,
			);
		}
		throw error;
	}

	const usable = environments.filter((env) => env.enabled !== false);
	const candidates = usable.length > 0 ? usable : environments;

	if (candidates.length === 0) {
		throw new ArcaneSetupError(
			`No Docker environments exist in Arcane at ${config.host}. Create one in the Arcane UI first.`,
		);
	}

	let chosen: Environment | undefined;
	if (candidates.length === 1) {
		chosen = candidates[0];
	} else if (ctx.hasUI) {
		const labels = candidates.map((env) => `${env.name ?? env.id} (${env.id})`);
		const picked = await ctx.ui.select("Select the Arcane environment to deploy to:", labels);
		if (!picked) throw new ArcaneSetupError("No Arcane environment selected.");
		chosen = candidates[labels.indexOf(picked)];
	} else {
		throw new ArcaneSetupError(
			[
				`Arcane has ${candidates.length} environments and no environmentId is configured.`,
				"Set environmentId in arcane.json to one of:",
				...candidates.map((env) => `  - ${env.id}  ${env.name ?? ""}`.trimEnd()),
			].join("\n"),
		);
	}

	if (!chosen) throw new ArcaneSetupError("No Arcane environment selected.");

	cachedEnvironmentId = chosen.id;
	cachedEnvironmentName = chosen.name;

	// Persist so later sessions skip the picker. Non-fatal if it fails.
	const target = config.sourcePath ?? configSearchPaths(ctx.cwd)[0];
	try {
		await writeConfigPatch(target, { environmentId: chosen.id });
		cachedConfig = { ...config, environmentId: chosen.id, sourcePath: target };
	} catch (error) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Selected environment ${chosen.id} but could not save it to ${target}: ${(error as Error).message}`,
				"warning",
			);
		}
	}

	return cachedEnvironmentId;
}

export async function requireRuntime(ctx: ExtensionContext): Promise<ArcaneRuntime> {
	const config = await requireConfig(ctx);
	const client = await requireClient(ctx);
	const environmentId = await requireEnvironmentId(ctx);
	return { config, client, environmentId, environmentName: cachedEnvironmentName };
}

/** Reflect a freshly written config without re-reading it from disk. */
export function primeRuntime(config: ArcaneConfig): void {
	cachedConfig = config;
	cachedClient = new ArcaneClient(config.host, config.apiKey);
	cachedEnvironmentId = config.environmentId;
	cachedEnvironmentName = undefined;
}

// ---------------------------------------------------------------------------
// Public URLs (plan 9.4, option A)
// ---------------------------------------------------------------------------

/**
 * Names the host's nginx vhost can route to.
 *
 * The existing `dynamic-tests` vhost matches `~^(?<t_name>t-[a-z0-9]+)\.hajek\.click$`
 * and proxies to `http://$t_name:5553` — so the Docker container must be named
 * exactly `t-<lowercase alphanumerics>`. Dashes and underscores after the
 * prefix do not match, which is why Compose's generated names
 * (`myapp-web-1`) are not reachable and a `container_name` has to be pinned.
 */
const ROUTABLE_NAME = /^t-[a-z0-9]+$/;

/** Container name for `projectName` that the `t-*` vhost will actually match. */
export function routableContainerName(projectName: string): string {
	const alnum = projectName.toLowerCase().replace(/[^a-z0-9]/g, "");
	return `${PUBLIC_HOST_PREFIX}${alnum || "app"}`;
}

/**
 * Public URL for a container, or `undefined` when its name cannot be routed by
 * the host's vhost. Returning `undefined` rather than a plausible-looking URL
 * keeps the deploy report honest — a guessed URL that 502s is worse than none.
 */
export function publicUrlForContainer(containerName: string): string | undefined {
	const name = containerName.replace(/^\//, "");
	if (!ROUTABLE_NAME.test(name)) return undefined;
	return `https://${name}.${PUBLIC_DOMAIN}`;
}

/** Explain why a container name has no public URL. */
export function unroutableReason(containerName: string): string {
	const name = containerName.replace(/^\//, "");
	return `container "${name}" does not match the host's t-[a-z0-9]+ vhost pattern, so it has no ${PUBLIC_DOMAIN} URL`;
}

/** Link to a project in the Arcane web UI. */
export function projectUiUrl(host: string, environmentId: string, projectId: string): string {
	return `${host}/environments/${encodeURIComponent(environmentId)}/projects/${encodeURIComponent(projectId)}`;
}
