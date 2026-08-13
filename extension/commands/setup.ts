/**
 * `/arcane-setup` — interactive configuration wizard (plan phase 4).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ArcaneApiError, ArcaneClient } from "../client.ts";
import {
	DEFAULT_HOST,
	configSearchPaths,
	defaultConfigPath,
	loadConfig,
	normalizeHost,
	resolveSecret,
	writeConfigPatch,
	type ArcaneConfig,
} from "../config.ts";
import { primeRuntime, resetRuntime } from "../runtime.ts";
import type { Environment } from "../types.ts";

export async function runSetup(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/arcane-setup needs an interactive UI. Edit arcane.json directly instead.", "error");
		return;
	}

	const existing = await safeLoad(ctx.cwd);

	// --- 1. Host -----------------------------------------------------------
	const hostAnswer = await ctx.ui.input(
		"Arcane host URL:",
		existing?.host ?? DEFAULT_HOST,
	);
	if (hostAnswer === undefined) {
		ctx.ui.notify("Setup cancelled.", "info");
		return;
	}
	const host = normalizeHost(hostAnswer.trim() || existing?.host || DEFAULT_HOST);

	// --- 2. API key ---------------------------------------------------------
	// The stored form is kept as typed ("$ARCANE_API_KEY" stays a reference)
	// so the key itself need not land in the file.
	const keyHint = existing
		? "leave empty to keep the current key"
		: "literal, $ENV_VAR, or !command";
	const keyAnswer = await ctx.ui.input(`Arcane API key (${keyHint}):`, "$ARCANE_API_KEY");
	if (keyAnswer === undefined) {
		ctx.ui.notify("Setup cancelled.", "info");
		return;
	}

	const apiKeyRaw = keyAnswer.trim();
	let apiKeyStored: string | undefined;
	let apiKeyResolved: string;

	if (apiKeyRaw) {
		apiKeyStored = apiKeyRaw;
		try {
			apiKeyResolved = await resolveSecret(apiKeyRaw);
		} catch (error) {
			ctx.ui.notify(`Could not resolve the API key: ${(error as Error).message}`, "error");
			return;
		}
	} else if (existing) {
		apiKeyResolved = existing.apiKey;
	} else {
		ctx.ui.notify("An API key is required.", "error");
		return;
	}

	// --- 3. Verify and list environments ------------------------------------
	const client = new ArcaneClient(host, apiKeyResolved);
	let environments: Environment[];
	try {
		environments = await client.listEnvironments();
	} catch (error) {
		if (error instanceof ArcaneApiError && error.isAuthError) {
			ctx.ui.notify(`Arcane rejected the key (HTTP ${error.status}). Setup aborted.`, "error");
		} else {
			ctx.ui.notify(`Could not reach ${host}/api: ${(error as Error).message}`, "error");
		}
		return;
	}

	if (environments.length === 0) {
		ctx.ui.notify(
			`Connected to ${host}, but it has no Docker environments. Create one in the Arcane UI, then re-run /arcane-setup.`,
			"warning",
		);
		return;
	}

	let environmentId: string | undefined;
	if (environments.length === 1) {
		environmentId = environments[0].id;
		ctx.ui.notify(
			`Using the only environment: ${environments[0].name ?? environmentId} (${environmentId})`,
			"info",
		);
	} else {
		const labels = environments.map((env) => `${env.name ?? env.id} (${env.id}) — ${env.status}`);
		const picked = await ctx.ui.select("Select the target environment:", labels);
		if (!picked) {
			ctx.ui.notify("Setup cancelled.", "info");
			return;
		}
		environmentId = environments[labels.indexOf(picked)].id;
	}

	// --- 4. Where to write --------------------------------------------------
	const candidates = configSearchPaths(ctx.cwd);
	const projectLabel = `${candidates[0]}  (project-local, gitignored)`;
	const globalLabel = `${candidates[2]}  (global, all projects)`;

	let target = existing?.sourcePath;
	if (!target) {
		const picked = await ctx.ui.select("Write the config to:", [projectLabel, globalLabel]);
		if (!picked) {
			ctx.ui.notify("Setup cancelled.", "info");
			return;
		}
		target = picked === globalLabel ? candidates[2] : defaultConfigPath(ctx.cwd);
	}

	try {
		await writeConfigPatch(target, {
			host,
			...(apiKeyStored ? { apiKey: apiKeyStored } : {}),
			environmentId,
		});
	} catch (error) {
		ctx.ui.notify(`Could not write ${target}: ${(error as Error).message}`, "error");
		return;
	}

	// --- 5. Re-prime the session with the new config ------------------------
	resetRuntime();
	const reloaded = await safeLoad(ctx.cwd);
	if (reloaded) primeRuntime(reloaded);

	ctx.ui.notify(
		`Arcane configured: ${host}, environment ${environmentId}. Written to ${target}.`,
		"info",
	);

	if (args.trim() === "test") {
		try {
			await client.testConnection();
			ctx.ui.notify("Connection test passed.", "info");
		} catch (error) {
			ctx.ui.notify(`Connection test failed: ${(error as Error).message}`, "error");
		}
	}
}

async function safeLoad(cwd: string): Promise<ArcaneConfig | undefined> {
	try {
		return await loadConfig(cwd);
	} catch {
		return undefined;
	}
}
