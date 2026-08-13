/**
 * `arcane_list` — enumerate resources in the configured environment
 * (plan phase 3.5).
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { publicUrlForContainer, requireRuntime } from "../runtime.ts";
import { toolError } from "./shared.ts";

const parameters = Type.Object({
	resource: StringEnum(["projects", "syncs", "containers", "repositories", "environments"] as const, {
		description: "Which kind of Arcane resource to list.",
	}),
});

export type ArcaneListInput = Static<typeof parameters>;

export function createListTool(): ToolDefinition<typeof parameters> {
	return defineTool({
		name: "arcane_list",
		label: "Arcane List",
		description: [
			"List Arcane resources in the configured Docker environment.",
			"",
			"resource:",
			"  projects      - compose projects, with status and service counts",
			"  syncs         - GitOps syncs, with branch, compose path and last sync result",
			"  containers    - running/stopped containers, with published ports and public URLs",
			"  repositories  - git repositories registered in Arcane (global, not per-environment)",
			"  environments  - all Docker environments Arcane can reach",
		].join("\n"),
		promptSnippet: "List Arcane projects, GitOps syncs, containers, git repositories or environments",
		parameters,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const { client, environmentId, config } = await requireRuntime(ctx);

				switch (params.resource) {
					case "environments": {
						const environments = await client.listEnvironments(signal);
						const lines = environments.map(
							(env) =>
								`${env.id === environmentId ? "*" : " "} ${env.id}  ${env.name ?? "(unnamed)"}  status=${env.status}  enabled=${env.enabled}`,
						);
						return {
							content: [
								{
									type: "text",
									text: header(`${environments.length} environment(s) at ${config.host}`, lines),
								},
							],
							details: { resource: params.resource, environments },
						};
					}

					case "repositories": {
						const repos = await client.listRepositories(signal);
						const lines = repos.map(
							(repo) =>
								`${repo.id}  ${repo.name}  ${repo.url}  auth=${repo.authType}  enabled=${repo.enabled}`,
						);
						return {
							content: [{ type: "text", text: header(`${repos.length} git repository(ies)`, lines) }],
							details: { resource: params.resource, repositories: repos },
						};
					}

					case "syncs": {
						const syncs = await client.listGitOpsSyncs(environmentId, signal);
						const lines = syncs.map((sync) =>
							[
								sync.id,
								sync.name,
								`project=${sync.projectName}`,
								`branch=${sync.branch}`,
								`compose=${sync.composePath}`,
								`autoSync=${sync.autoSync}`,
								`last=${sync.lastSyncStatus ?? "never"}${sync.lastSyncAt ? ` @ ${sync.lastSyncAt}` : ""}`,
								sync.lastSyncError ? `error=${sync.lastSyncError}` : "",
							]
								.filter(Boolean)
								.join("  "),
						);
						return {
							content: [{ type: "text", text: header(`${syncs.length} GitOps sync(s)`, lines) }],
							details: { resource: params.resource, syncs },
						};
					}

					case "projects": {
						const projects = await client.listProjects(environmentId, signal);
						const lines = projects.map((project) =>
							[
								project.id,
								project.name,
								`status=${project.status}`,
								`services=${project.runningCount}/${project.serviceCount}`,
								project.gitOpsManagedBy ? `gitops=${project.gitOpsManagedBy}` : "",
								project.isArchived ? "archived" : "",
							]
								.filter(Boolean)
								.join("  "),
						);
						return {
							content: [{ type: "text", text: header(`${projects.length} project(s)`, lines) }],
							details: { resource: params.resource, projects },
						};
					}

					case "containers": {
						const containers = await client.listContainers(environmentId, signal);
						const lines = containers.map((container) => {
							const name = (container.names ?? [])[0]?.replace(/^\//, "") ?? container.id.slice(0, 12);
							const ports = (container.ports ?? [])
								.filter((p) => p.publicPort)
								.map((p) => `${p.publicPort}->${p.privatePort}/${p.type}`)
								.join(",");
							return [
								name,
								`id=${container.id.slice(0, 12)}`,
								`state=${container.state}`,
								`image=${container.image}`,
								ports ? `ports=${ports}` : "",
								container.state === "running" ? publicUrlForContainer(name) : "",
							]
								.filter(Boolean)
								.join("  ");
						});
						return {
							content: [{ type: "text", text: header(`${containers.length} container(s)`, lines) }],
							details: { resource: params.resource, containers },
						};
					}

					default:
						throw new Error(`Unknown resource: ${String(params.resource)}`);
				}
			} catch (error) {
				throw toolError(error);
			}
		},
	});
}

function header(title: string, lines: string[]): string {
	if (lines.length === 0) return `${title}\n(none)`;
	return `${title}\n${lines.join("\n")}`;
}
