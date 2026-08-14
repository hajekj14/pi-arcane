/**
 * `/arcane-status` — dashboard of the configured environment (plan phase 4).
 *
 * Renders into the transcript as a custom entry so the summary persists in the
 * session without entering the LLM's context.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { optionalUpload, publicUrlsForContainer, requireRuntime } from "../runtime.ts";
import { listContexts } from "../upload.ts";

export const STATUS_ENTRY_TYPE = "arcane-status";

export interface StatusEntryData {
	host: string;
	environmentId: string;
	environmentName?: string;
	environmentStatus?: string;
	projects: Array<{
		name: string;
		status: string;
		running: number;
		total: number;
	}>;
	/** Build contexts uploaded to the Arcane host, by slug. */
	contexts: string[];
	containers: Array<{ name: string; state: string; ports: string; url?: string }>;
	error?: string;
}

export async function runStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	ctx.ui.setStatus("arcane", "Loading Arcane status…");
	try {
		const { client, environmentId, environmentName, config } = await requireRuntime(ctx);

		const upload = await optionalUpload(ctx);
		const [projects, containers, environment, contexts] = await Promise.all([
			client.listProjects(environmentId),
			client.listContainers(environmentId),
			// Non-fatal: the dashboard still renders without the environment row.
			client.getEnvironment(environmentId).catch(() => undefined),
			upload
				? listContexts(client, environmentId, upload).catch(() => [] as string[])
				: Promise.resolve([] as string[]),
		]);

		const data: StatusEntryData = {
			host: config.host,
			environmentId,
			environmentName: environment?.name ?? environmentName,
			environmentStatus: environment?.status,
			projects: projects.map((project) => ({
				name: project.name,
				status: project.status,
				running: project.runningCount,
				total: project.serviceCount,
			})),
			contexts,
			containers: containers.map((container) => {
				const name =
					(container.names ?? [])[0]?.replace(/^\//, "") ?? container.id.slice(0, 12);
				return {
					name,
					state: container.state,
					ports: (container.ports ?? [])
						.filter((p) => p.publicPort)
						.map((p) => `${p.publicPort}->${p.privatePort}`)
						.join(","),
					url:
						container.state === "running"
							? publicUrlsForContainer(container.ports)[0]
							: undefined,
				};
			}),
		};

		pi.appendEntry(STATUS_ENTRY_TYPE, data);
		ctx.ui.notify(
			`Arcane: ${data.projects.length} project(s), ${data.containers.filter((c) => c.state === "running").length} container(s) running.`,
			"info",
		);
	} catch (error) {
		const message = (error as Error).message;
		pi.appendEntry(STATUS_ENTRY_TYPE, {
			host: "",
			environmentId: "",
			projects: [],
			contexts: [],
			containers: [],
			error: message,
		} satisfies StatusEntryData);
		ctx.ui.notify(`Arcane status failed: ${message}`, "error");
	} finally {
		ctx.ui.setStatus("arcane", undefined);
	}
}
