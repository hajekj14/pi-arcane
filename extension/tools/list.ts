/**
 * `arcane_list` — enumerate resources in the configured environment
 * (plan phase 3.5).
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { optionalUpload, publicUrlsForContainer, requireRuntime } from "../runtime.ts";
import { listContexts } from "../upload.ts";
import { toolError } from "./shared.ts";

const parameters = Type.Object({
	resource: StringEnum(["projects", "contexts", "containers", "environments"] as const, {
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
			"  contexts      - build contexts uploaded to the Arcane host, including orphans",
			"  containers    - running/stopped containers, with published ports and public URLs",
			"  environments  - all Docker environments Arcane can reach",
		].join("\n"),
		promptSnippet: "List Arcane projects, uploaded build contexts, containers or environments",
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

					case "contexts": {
						const upload = await optionalUpload(ctx);
						if (!upload) {
							return {
								content: [
									{
										type: "text",
										text: "No upload sidecar is configured, so there are no uploaded build contexts. Set upload.url in arcane.json.",
									},
								],
								details: { resource: params.resource, contexts: [] },
							};
						}

						const slugs = await listContexts(client, environmentId, upload, signal);
						const projects = await client.listProjects(environmentId, signal);
						// A context whose project is gone is dead weight on the host; say so
						// rather than leaving it to be discovered by a disk-full alert.
						const lines = slugs.map((slug) => {
							const owner = projects.find((p) => slug.startsWith(`${p.name}-`));
							return `${slug}  ${upload.containerPath}/${slug}/ctx  ${
								owner ? `project=${owner.name}` : "orphan (no matching project)"
							}`;
						});
						return {
							content: [
								{ type: "text", text: header(`${slugs.length} uploaded build context(s)`, lines) },
							],
							details: { resource: params.resource, contexts: slugs },
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
								container.state === "running" ? publicUrlsForContainer(container.ports).join(" ") : "",
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
