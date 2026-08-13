/**
 * `arcane_logs` — read container or project logs (plan phase 3.4).
 *
 * Arcane exposes logs only over WebSocket, so this drains a `follow=false`
 * stream and returns the tail as text.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { requireRuntime } from "../runtime.ts";
import type { ContainerSummary } from "../types.ts";
import { toolError } from "./shared.ts";

const parameters = Type.Object({
	container_id: Type.Optional(
		Type.String({
			description:
				"Container ID or name. Accepts a partial ID or the plain name without the leading slash.",
		}),
	),
	project_name: Type.Optional(
		Type.String({
			description:
				"Read the combined logs of every service in this Arcane project instead of one container.",
		}),
	),
	tail: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 5000,
			description: "Number of lines to read from the end. Default 100.",
		}),
	),
	timestamps: Type.Optional(
		Type.Boolean({ description: "Prefix each line with its timestamp. Default false." }),
	),
});

export type ArcaneLogsInput = Static<typeof parameters>;

export function createLogsTool(): ToolDefinition<typeof parameters> {
	return defineTool({
		name: "arcane_logs",
		label: "Arcane Logs",
		description: [
			"Read logs from a container or a whole project deployed on Arcane.",
			"",
			"Provide either container_id (ID, partial ID, or container name) or project_name.",
			"Output is the tail of the log, truncated to 50KB / 2000 lines from the end.",
		].join("\n"),
		promptSnippet: "Read logs from an Arcane container or project",
		parameters,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const { client, environmentId } = await requireRuntime(ctx);

				if (!params.container_id && !params.project_name) {
					throw new Error("Provide either container_id or project_name.");
				}

				const tail = params.tail ?? 100;
				let raw: string;
				let source: string;

				if (params.project_name) {
					const projects = await client.listProjects(environmentId, signal);
					const project =
						projects.find((p) => p.name === params.project_name) ??
						projects.find((p) => p.id === params.project_name) ??
						projects.find((p) =>
							p.name.toLowerCase().includes(params.project_name!.toLowerCase()),
						);
					if (!project) {
						throw new Error(
							`No project named "${params.project_name}". Known projects: ${
								projects.map((p) => p.name).join(", ") || "(none)"
							}`,
						);
					}
					source = `project ${project.name} (${project.id})`;
					raw = await client.getProjectLogs(environmentId, project.id, {
						tail,
						timestamps: params.timestamps,
						signal,
					});
				} else {
					const containers = await client.listContainers(environmentId, signal);
					const container = resolveContainer(containers, params.container_id!);
					if (!container) {
						throw new Error(
							`No container matches "${params.container_id}". Known containers: ${
								containers
									.map((c) => (c.names ?? [])[0]?.replace(/^\//, "") ?? c.id.slice(0, 12))
									.join(", ") || "(none)"
							}`,
						);
					}
					const name = (container.names ?? [])[0]?.replace(/^\//, "") ?? container.id.slice(0, 12);
					source = `container ${name} (${container.id.slice(0, 12)})`;
					raw = await client.getContainerLogs(environmentId, container.id, {
						tail,
						timestamps: params.timestamps,
						signal,
					});
				}

				if (!raw.trim()) {
					return {
						content: [{ type: "text", text: `${source}: no log output (last ${tail} lines).` }],
						details: { source, empty: true },
					};
				}

				const truncation = truncateTail(raw, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});
				let text = `${source}, last ${tail} lines:\n${truncation.content}`;
				if (truncation.truncated) {
					text += `\n\n[Output truncated: kept ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Re-run with a smaller tail for less.]`;
				}

				return {
					content: [{ type: "text", text }],
					details: { source, lines: truncation.outputLines, truncated: truncation.truncated },
				};
			} catch (error) {
				throw toolError(error);
			}
		},
	});
}

/** Resolve by exact ID, ID prefix, exact name, then name substring. */
function resolveContainer(
	containers: ContainerSummary[],
	needle: string,
): ContainerSummary | undefined {
	const key = needle.replace(/^\//, "").trim();
	const names = (c: ContainerSummary) => (c.names ?? []).map((n) => n.replace(/^\//, ""));

	return (
		containers.find((c) => c.id === key) ??
		containers.find((c) => c.id.startsWith(key)) ??
		containers.find((c) => names(c).includes(key)) ??
		containers.find((c) => names(c).some((n) => n.includes(key)))
	);
}
