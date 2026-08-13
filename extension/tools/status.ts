/**
 * `arcane_status` — current state of projects, syncs and their containers
 * (plan phase 3.2).
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { publicUrlsForContainer, requireRuntime } from "../runtime.ts";
import type { ContainerSummary, GitOpsSync, ProjectDetails } from "../types.ts";
import { fields, toolError } from "./shared.ts";

const parameters = Type.Object({
	project_name: Type.Optional(
		Type.String({ description: "Only report the project with this name." }),
	),
	sync_name: Type.Optional(Type.String({ description: "Only report the GitOps sync with this name." })),
});

export type ArcaneStatusInput = Static<typeof parameters>;

export function createStatusTool(): ToolDefinition<typeof parameters> {
	return defineTool({
		name: "arcane_status",
		label: "Arcane Status",
		description: [
			"Report deployment status from Arcane: projects with their service counts and",
			"health, the GitOps syncs feeding them, and the containers they are running",
			"(including published ports and public URLs).",
			"",
			"With no arguments, reports everything in the configured environment.",
			"Filters are case-insensitive substring matches.",
		].join("\n"),
		promptSnippet: "Check deployment status of Arcane projects, syncs and containers",
		parameters,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const { client, environmentId, config } = await requireRuntime(ctx);

				const [projects, syncs, containers] = await Promise.all([
					client.listProjects(environmentId, signal),
					client.listGitOpsSyncs(environmentId, signal),
					client.listContainers(environmentId, signal),
				]);

				const matchedProjects = filterByName(projects, params.project_name, (p) => p.name);
				const matchedSyncs = filterByName(syncs, params.sync_name, (s) => s.name);

				// When only a project filter was given, narrow syncs to that project too.
				const relevantSyncs =
					params.sync_name === undefined && params.project_name !== undefined
						? syncs.filter((sync) =>
								matchedProjects.some(
									(p) => p.name === sync.projectName || p.id === sync.projectId,
								),
							)
						: matchedSyncs;

				const sections: string[] = [];
				sections.push(`Arcane ${config.host}  environment=${environmentId}`);

				sections.push(renderProjects(matchedProjects, containers));
				sections.push(renderSyncs(relevantSyncs));

				if (params.project_name && matchedProjects.length === 0) {
					sections.push(
						`No project matches "${params.project_name}". Known projects: ${
							projects.map((p) => p.name).join(", ") || "(none)"
						}`,
					);
				}
				if (params.sync_name && matchedSyncs.length === 0) {
					sections.push(
						`No sync matches "${params.sync_name}". Known syncs: ${
							syncs.map((s) => s.name).join(", ") || "(none)"
						}`,
					);
				}

				return {
					content: [{ type: "text", text: sections.join("\n\n") }],
					details: {
						environmentId,
						projects: matchedProjects,
						syncs: relevantSyncs,
						containers,
					},
				};
			} catch (error) {
				throw toolError(error);
			}
		},
	});
}

function filterByName<T>(items: T[], needle: string | undefined, name: (item: T) => string): T[] {
	if (!needle) return items;
	const lowered = needle.toLowerCase();
	const exact = items.filter((item) => name(item).toLowerCase() === lowered);
	if (exact.length > 0) return exact;
	return items.filter((item) => name(item).toLowerCase().includes(lowered));
}

function renderProjects(projects: ProjectDetails[], containers: ContainerSummary[]): string {
	if (projects.length === 0) return "Projects:\n  (none)";

	const lines: string[] = ["Projects:"];
	for (const project of projects) {
		lines.push(
			`  ${project.name}  ${fields([
				["id", project.id],
				["status", project.status],
				["services", `${project.runningCount}/${project.serviceCount}`],
				["gitops", project.gitOpsManagedBy],
				["commit", project.lastSyncCommit?.slice(0, 8)],
				["updated", project.updatedAt],
			])}`,
		);
		if (project.statusReason) lines.push(`    reason: ${project.statusReason}`);

		const projectContainers = containersForProject(containers, project.name);
		for (const container of projectContainers) {
			const name = (container.names ?? [])[0]?.replace(/^\//, "") ?? container.id.slice(0, 12);
			const ports = (container.ports ?? [])
				.filter((p) => p.publicPort)
				.map((p) => `${p.publicPort}->${p.privatePort}/${p.type}`)
				.join(",");
			lines.push(
				`    - ${name}  ${fields([
					["state", container.state],
					["status", container.status],
					["ports", ports],
				])}`,
			);
			if (container.state === "running") {
				const urls = publicUrlsForContainer(container.ports);
				if (urls.length > 0) lines.push(`      url: ${urls.join("  ")}`);
				else lines.push("      url: none (publishes no host port)");
			}
		}
		if (projectContainers.length === 0) lines.push("    - (no containers)");
	}
	return lines.join("\n");
}

/** Match by the compose project label Docker sets, falling back to the name prefix. */
function containersForProject(
	containers: ContainerSummary[],
	projectName: string,
): ContainerSummary[] {
	const labelled = containers.filter(
		(c) => c.labels?.["com.docker.compose.project"] === projectName,
	);
	if (labelled.length > 0) return labelled;
	return containers.filter((c) =>
		(c.names ?? []).some((n) => n.replace(/^\//, "").startsWith(`${projectName}-`) || n.replace(/^\//, "").startsWith(`${projectName}_`)),
	);
}

function renderSyncs(syncs: GitOpsSync[]): string {
	if (syncs.length === 0) return "GitOps syncs:\n  (none)";

	const lines: string[] = ["GitOps syncs:"];
	for (const sync of syncs) {
		lines.push(
			`  ${sync.name}  ${fields([
				["id", sync.id],
				["project", sync.projectName],
				["branch", sync.branch],
				["compose", sync.composePath],
				["target", sync.targetType],
				["autoSync", sync.autoSync],
				["interval", sync.autoSync ? `${sync.syncInterval}s` : undefined],
			])}`,
		);
		lines.push(
			`    last: ${fields([
				["status", sync.lastSyncStatus ?? "never"],
				["at", sync.lastSyncAt],
				["commit", sync.lastSyncCommit?.slice(0, 8)],
			])}`,
		);
		if (sync.lastSyncError) lines.push(`    error: ${sync.lastSyncError}`);
	}
	return lines.join("\n");
}
