/**
 * `/arcane-setup` — interactive configuration wizard (plan phase 4).
 *
 * Prompt handling note: pi's `ui.input(title, placeholder)` takes a
 * *placeholder*, not a prefilled value, and returns `""` or `undefined` when the
 * user submits without typing. An earlier version showed defaults that were
 * never applied and treated an empty answer as "cancel", so pressing Enter
 * through the wizard wrote no file at all. Empty now means "take the default
 * shown", and the only way to abort is the explicit confirmation at the end.
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
		ctx.ui.notify(
			"/arcane-setup needs an interactive UI. Edit arcane.json directly instead.",
			"error",
		);
		return;
	}

	const existing = await safeLoad(ctx.cwd);

	/** Ask, and fall back to `fallback` when the user types nothing. */
	async function ask(title: string, fallback: string): Promise<string> {
		const answer = await ctx.ui.input(`${title} [${fallback || "none"}]`, fallback);
		return (answer ?? "").trim() || fallback;
	}

	// --- 1. Host -------------------------------------------------------------
	const host = normalizeHost(await ask("Arcane host URL:", existing?.host ?? DEFAULT_HOST));

	// --- 2. API key ----------------------------------------------------------
	// Stored as typed, so "$ARCANE_API_KEY" stays a reference and the key itself
	// need not land in the file.
	const keyFallback = existing?.sourcePath
		? "" // a file already holds one; empty means "keep it"
		: process.env.ARCANE_API_KEY
			? "$ARCANE_API_KEY"
			: "";
	const keyAnswer = await ask(
		`Arcane API key (literal, $ENV_VAR or !command)${existing?.sourcePath ? ", empty keeps the current one" : ""}:`,
		keyFallback,
	);

	let apiKeyStored: string | undefined;
	let apiKeyResolved: string;

	if (keyAnswer) {
		apiKeyStored = keyAnswer;
		try {
			apiKeyResolved = await resolveSecret(keyAnswer);
		} catch (error) {
			ctx.ui.notify(`Could not resolve the API key: ${(error as Error).message}`, "error");
			return;
		}
	} else if (existing) {
		apiKeyResolved = existing.apiKey;
	} else {
		ctx.ui.notify(
			"An API key is required: pass a literal, $ARCANE_API_KEY, or !command. Nothing was written.",
			"error",
		);
		return;
	}

	// --- 3. Environment ------------------------------------------------------
	// A failure here must not lose the answers already given: the config is still
	// written, minus environmentId, so the user has something to fix rather than
	// nothing at all.
	const client = new ArcaneClient(host, apiKeyResolved);
	let environmentId: string | undefined = existing?.environmentId;
	let environmentNote = environmentId ? `kept ${environmentId}` : "not set";

	try {
		const environments = await client.listEnvironments();
		if (environments.length === 0) {
			environmentNote = "none exist in Arcane yet";
			ctx.ui.notify(
				`Connected to ${host}, but it has no Docker environments. Create one in the Arcane UI, then re-run /arcane-setup.`,
				"warning",
			);
		} else if (environments.length === 1) {
			environmentId = environments[0].id;
			environmentNote = `${environments[0].name ?? environmentId} (${environmentId})`;
		} else {
			const picked = await pickEnvironment(ctx, environments);
			if (picked) {
				environmentId = picked.id;
				environmentNote = `${picked.name ?? picked.id} (${picked.id})`;
			} else if (environmentId) {
				environmentNote = `kept ${environmentId}`;
			} else {
				environmentNote = "not selected — the extension will ask again on first use";
			}
		}
	} catch (error) {
		const reason =
			error instanceof ArcaneApiError && error.isAuthError
				? `Arcane rejected the key (HTTP ${error.status})`
				: `could not reach ${host}/api: ${(error as Error).message}`;
		environmentNote = `unknown — ${reason}`;
		ctx.ui.notify(`${reason}. Writing the config anyway so you can correct it.`, "warning");
	}

	// --- 4. Upload sidecar ---------------------------------------------------
	// Every deploy pushes the working tree through it, so a config without one
	// cannot deploy at all.
	const uploadUrl = (
		await ask("Upload sidecar URL (required for deploys):", existing?.upload?.url ?? "")
	).replace(/\/+$/, "");

	// --- 5. Where to write ---------------------------------------------------
	const candidates = configSearchPaths(ctx.cwd);
	const projectPath = defaultConfigPath(ctx.cwd);
	let target = existing?.sourcePath;
	if (!target) {
		const projectLabel = `${projectPath}  (project-local, gitignored)`;
		const globalLabel = `${candidates[2]}  (global, all projects)`;
		const picked = await ctx.ui.select("Write the config to:", [projectLabel, globalLabel]);
		// Dismissing the picker is not a cancellation — the confirmation below is.
		target = picked === globalLabel ? candidates[2] : projectPath;
	}

	// --- 6. Confirm, then write ----------------------------------------------
	const summary = [
		`host:        ${host}`,
		`apiKey:      ${apiKeyStored ?? (existing?.sourcePath ? "(unchanged)" : "(from ARCANE_API_KEY)")}`,
		`environment: ${environmentNote}`,
		`upload:      ${uploadUrl || "(none — deploys will refuse to run)"}`,
		"",
		`write to:    ${target}`,
	].join("\n");

	const ok = await ctx.ui.confirm("Save this Arcane config?", summary);
	if (!ok) {
		ctx.ui.notify("Setup cancelled — nothing was written.", "warning");
		return;
	}

	try {
		await writeConfigPatch(target, {
			host,
			...(apiKeyStored ? { apiKey: apiKeyStored } : {}),
			...(environmentId ? { environmentId } : {}),
			// The token is left unset on purpose: it defaults to the Arcane API key,
			// which the sidecar is deployed with.
			...(uploadUrl ? { upload: { url: uploadUrl } } : {}),
		});
	} catch (error) {
		ctx.ui.notify(`Could not write ${target}: ${(error as Error).message}`, "error");
		return;
	}

	// --- 7. Re-prime, and prove the file actually loads -----------------------
	resetRuntime();
	const reloaded = await safeLoad(ctx.cwd);
	if (!reloaded) {
		ctx.ui.notify(
			`Wrote ${target}, but reading it back produced no usable config. Check the file.`,
			"error",
		);
		return;
	}
	primeRuntime(reloaded);

	ctx.ui.notify(
		`Arcane configured — wrote ${target} (host ${reloaded.host}, environment ${
			reloaded.environmentId ?? "unset"
		}, upload ${reloaded.upload?.url ?? "unset"}).`,
		"info",
	);
	if (!reloaded.upload) {
		ctx.ui.notify(
			"No upload sidecar configured: arcane_deploy and arcane_build will refuse to run. Deploy one with upload-server/docker-compose.yml, then re-run /arcane-setup.",
			"warning",
		);
	}

	if (args.trim() === "test") {
		try {
			await client.testConnection();
			ctx.ui.notify("Connection test passed.", "info");
		} catch (error) {
			ctx.ui.notify(`Connection test failed: ${(error as Error).message}`, "error");
		}
	}
}

async function pickEnvironment(
	ctx: ExtensionCommandContext,
	environments: Environment[],
): Promise<Environment | undefined> {
	const labels = environments.map((env) => `${env.name ?? env.id} (${env.id}) — ${env.status}`);
	const picked = await ctx.ui.select("Select the target environment:", labels);
	if (!picked) return undefined;
	return environments[labels.indexOf(picked)];
}

async function safeLoad(cwd: string): Promise<ArcaneConfig | undefined> {
	try {
		return await loadConfig(cwd);
	} catch {
		return undefined;
	}
}
