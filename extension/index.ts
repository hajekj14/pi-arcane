/**
 * pi-arcane — develop → deploy through Arcane.
 *
 * Registers the `arcane_*` tools the model calls, the `/arcane-setup` and
 * `/arcane-status` commands, and the renderers for the custom entries those
 * write into the session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { runSetup } from "./commands/setup.ts";
import { runStatus, STATUS_ENTRY_TYPE, type StatusEntryData } from "./commands/status.ts";
import { resetRuntime } from "./runtime.ts";
import { createBuildTool } from "./tools/build.ts";
import { createDeployTool } from "./tools/deploy.ts";
import { createListTool } from "./tools/list.ts";
import { createLogsTool } from "./tools/logs.ts";
import { createStatusTool } from "./tools/status.ts";
import { DEPLOYMENT_ENTRY_TYPE, type DeploymentRecord } from "./types.ts";

export type { ArcaneDeployInput } from "./tools/deploy.ts";
export type { ArcaneStatusInput } from "./tools/status.ts";
export type { ArcaneBuildInput } from "./tools/build.ts";
export type { ArcaneLogsInput } from "./tools/logs.ts";
export type { ArcaneListInput } from "./tools/list.ts";

export default function arcaneExtension(pi: ExtensionAPI): void {
	// --- Tools --------------------------------------------------------------
	pi.registerTool(createDeployTool(pi));
	pi.registerTool(createStatusTool());
	pi.registerTool(createBuildTool());
	pi.registerTool(createLogsTool());
	pi.registerTool(createListTool());

	// --- Commands -----------------------------------------------------------
	pi.registerCommand("arcane-setup", {
		description: "Configure the Arcane host, API key and target environment",
		handler: async (args, ctx) => {
			await runSetup(args, ctx);
		},
	});

	pi.registerCommand("arcane-status", {
		description: "Show Arcane projects, GitOps syncs and running containers",
		handler: async (_args, ctx) => {
			await runStatus(pi, ctx);
		},
	});

	// --- Session state ------------------------------------------------------
	// Config, client and environment are cached per session; a new or resumed
	// session must not inherit the previous project's Arcane settings.
	pi.on("session_start", async (_event, ctx) => {
		resetRuntime();

		// Surface the last deploy of this branch so the footer reflects reality
		// after a restart (plan 6.6).
		let latest: DeploymentRecord | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === DEPLOYMENT_ENTRY_TYPE) {
				latest = entry.data as DeploymentRecord;
			}
		}
		if (latest && ctx.hasUI) {
			ctx.ui.setStatus(
				"arcane",
				`arcane: ${latest.projectName} ${latest.status}${latest.urls?.[0] ? ` ${latest.urls[0]}` : ""}`,
			);
		}
	});

	pi.on("session_shutdown", async () => {
		resetRuntime();
	});

	// --- Entry rendering ----------------------------------------------------
	pi.registerEntryRenderer(DEPLOYMENT_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data as DeploymentRecord;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const ok = data.status === "success";
		const headline = `${theme.bold("Arcane deploy")} ${theme.fg(
			ok ? "success" : "error",
			ok ? "✓" : "✗",
		)} ${data.projectName}${data.branch ? ` @ ${data.branch}` : ""}`;
		box.addChild(new Text(headline));

		for (const url of data.urls ?? []) box.addChild(new Text(theme.fg("accent", `  ${url}`)));
		if (data.error) box.addChild(new Text(theme.fg("error", `  ${data.error}`)));

		if (expanded) {
			box.addChild(new Text(theme.fg("dim", JSON.stringify(data, null, 2))));
		}
		return box;
	});

	pi.registerEntryRenderer(STATUS_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data as StatusEntryData;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));

		if (data.error) {
			box.addChild(new Text(`${theme.bold("Arcane status")} ${theme.fg("error", data.error)}`));
			return box;
		}

		box.addChild(
			new Text(
				`${theme.bold("Arcane")} ${theme.fg("dim", data.host)} ${theme.fg(
					"muted",
					data.environmentName ?? data.environmentId,
				)}`,
			),
		);

		box.addChild(new Text(theme.fg("muted", `Projects (${data.projects.length})`)));
		for (const project of data.projects) {
			const healthy = project.running === project.total && project.total > 0;
			box.addChild(
				new Text(
					`  ${theme.fg(healthy ? "success" : "warning", "●")} ${project.name} ${theme.fg(
						"dim",
						`${project.status} ${project.running}/${project.total}`,
					)}`,
				),
			);
		}

		const running = data.containers.filter((c) => c.state === "running");
		box.addChild(new Text(theme.fg("muted", `Containers running (${running.length})`)));
		for (const container of running) {
			box.addChild(
				new Text(
					`  ${container.name} ${theme.fg("dim", container.ports)}${
						container.url ? ` ${theme.fg("accent", container.url)}` : ""
					}`,
				),
			);
		}

		if (expanded) {
			box.addChild(new Text(theme.fg("muted", `Syncs (${data.syncs.length})`)));
			for (const sync of data.syncs) {
				box.addChild(
					new Text(
						`  ${sync.name} ${theme.fg("dim", `${sync.branch} ${sync.lastStatus}${sync.lastAt ? ` @ ${sync.lastAt}` : ""}`)}`,
					),
				);
				if (sync.error) box.addChild(new Text(theme.fg("error", `    ${sync.error}`)));
			}
		}

		return box;
	});
}
