/**
 * `arcane_destroy` — tear down a deployment (plan phase 7.1).
 *
 * Destructive and not undoable, so it is deliberately narrow: it resolves one
 * unambiguous project, asks for confirmation when there is a UI, and never
 * touches volumes unless explicitly told to. It also removes the build context
 * uploaded for the project, which would otherwise sit on the Arcane host
 * indefinitely.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { readGitContext } from "../git.ts";
import { optionalUpload, requireRuntime } from "../runtime.ts";
import type { ProjectDetails } from "../types.ts";
import { contextSlug, removeContext } from "../upload.ts";
import { fields, toolError } from "./shared.ts";

const parameters = Type.Object({
	project_name: Type.String({
		description:
			"Name of the Arcane project to destroy. Must match exactly one project; no wildcards.",
	}),
	remove_volumes: Type.Optional(
		Type.Boolean({
			description:
				"Also delete the project's named volumes and their data. Default false — this is not recoverable.",
		}),
	),
	remove_files: Type.Optional(
		Type.Boolean({
			description:
				"Also delete the project directory on the Arcane host. Default true, since the next deploy recreates it from the upload.",
		}),
	),
	remove_context: Type.Optional(
		Type.Boolean({
			description:
				"Also delete the build context uploaded for this project. Default true; keeping it only wastes disk on the Arcane host.",
		}),
	),
});

export type ArcaneDestroyInput = Static<typeof parameters>;

export function createDestroyTool(): ToolDefinition<typeof parameters> {
	return defineTool({
		name: "arcane_destroy",
		label: "Arcane Destroy",
		description: [
			"Tear down a deployed Arcane project: stop its containers, destroy the project,",
			"and by default delete the build context uploaded for it.",
			"",
			"This is destructive and cannot be undone. Volumes are kept unless remove_volumes",
			"is set.",
			"",
			"Use arcane_list or arcane_status first if unsure of the exact project name.",
		].join("\n"),
		promptSnippet: "Destroy a deployed Arcane project and its uploaded build context",
		promptGuidelines: [
			"Use arcane_destroy only when the user explicitly asks to delete, destroy, or tear down a deployment.",
		],
		parameters,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const progress: string[] = [];
			const step = (message: string) => {
				progress.push(message);
				onUpdate?.({ content: [{ type: "text", text: progress.join("\n") }], details: {} });
			};

			try {
				const { client, environmentId } = await requireRuntime(ctx);

				const removeVolumes = params.remove_volumes ?? false;
				const removeFiles = params.remove_files ?? true;
				const removeUploadedContext = params.remove_context ?? true;

				// --- resolve exactly one project --------------------------------
				const projects = await client.listProjects(environmentId, signal);
				const project = resolveProject(projects, params.project_name);

				if (!project) {
					throw new Error(
						`No project named "${params.project_name}". Known projects: ${
							projects.map((p) => p.name).join(", ") || "(none)"
						}`,
					);
				}
				if (Array.isArray(project)) {
					throw new Error(
						`"${params.project_name}" matches ${project.length} projects (${project
							.map((p) => p.name)
							.join(", ")}). Pass the exact name.`,
					);
				}

				// --- confirm ------------------------------------------------------
				if (ctx.hasUI) {
					const ok = await ctx.ui.confirm(
						`Destroy "${project.name}"?`,
						[
							`Project ${project.name} (${project.id}) with ${project.serviceCount} service(s).`,
							removeVolumes ? "Volumes AND THEIR DATA will be deleted." : "Volumes will be kept.",
							removeUploadedContext
								? "The uploaded build context will be deleted too."
								: "The uploaded build context will be kept.",
							"This cannot be undone.",
						].join("\n"),
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: `Cancelled — "${project.name}" was not touched.` }],
							details: { cancelled: true, projectName: project.name },
						};
					}
				}

				// --- stop, then destroy -------------------------------------------
				try {
					await client.stopProject(environmentId, project.id, signal);
					step(`Stopped ${project.name}.`);
				} catch (error) {
					// destroy stops the project itself, so a failure here is not fatal.
					step(`Stop reported: ${(error as Error).message}`);
				}

				const result = await client.destroyProject(
					environmentId,
					project.id,
					{ removeFiles, removeVolumes },
					signal,
				);
				step(result.message || `Destroyed ${project.name}.`);

				if (result.activityId) {
					const outcome = await client.waitForActivity(environmentId, result.activityId, {
						signal,
						timeoutMs: 10 * 60_000,
					});
					if (!outcome.ok) {
						step(`Teardown activity finished as ${outcome.activity.status}.`);
					}
				}

				// --- remove the uploaded build context -----------------------------
				// After the teardown, not before: deleting the context first would
				// strand the build inputs if destroying the project then failed.
				let contextNote = "kept";
				if (removeUploadedContext) {
					const upload = await optionalUpload(ctx);
					if (!upload) {
						contextNote = "skipped (no upload sidecar configured)";
					} else {
						const git = await readGitContext(ctx.cwd, signal);
						const slug = contextSlug(git?.repoRoot ?? ctx.cwd, project.name);
						const outcome = await removeContext(client, environmentId, upload, slug, signal);
						contextNote = outcome.removed ? `deleted (${slug})` : `not deleted: ${outcome.reason}`;
					}
					step(`Uploaded context: ${contextNote}`);
				}

				// --- verify it is actually gone ------------------------------------
				const remainingProjects = await client.listProjects(environmentId, signal);
				const stillThere = remainingProjects.some((p) => p.id === project.id);
				const containers = await client.listContainers(environmentId, signal);
				const strayContainers = containers.filter(
					(c) => c.labels?.["com.docker.compose.project"] === project.name,
				);

				const lines = [
					stillThere
						? `Arcane still lists project "${project.name}" — check the Arcane UI.`
						: `Destroyed "${project.name}".`,
					fields([
						["projectId", project.id],
						["volumes", removeVolumes ? "deleted" : "kept"],
						["files", removeFiles ? "deleted" : "kept"],
						["uploadedContext", contextNote],
					]),
				];
				if (strayContainers.length > 0) {
					lines.push(
						`Warning: ${strayContainers.length} container(s) still carry this project's label: ${strayContainers
							.map((c) => (c.names ?? [])[0]?.replace(/^\//, "") ?? c.id.slice(0, 12))
							.join(", ")}`,
					);
				}

				const text = lines.join("\n");
				if (stillThere) throw new Error(text);

				return {
					content: [{ type: "text", text }],
					details: {
						projectName: project.name,
						projectId: project.id,
						uploadedContext: contextNote,
						removeVolumes,
						removeFiles,
					},
				};
			} catch (error) {
				throw toolError(error);
			}
		},
	});
}

/**
 * Exact name wins; otherwise fall back to a substring match but return every
 * candidate so the caller can refuse rather than destroy the wrong project.
 */
function resolveProject(
	projects: ProjectDetails[],
	needle: string,
): ProjectDetails | ProjectDetails[] | undefined {
	const exact = projects.find((p) => p.name === needle);
	if (exact) return exact;

	const byId = projects.find((p) => p.id === needle);
	if (byId) return byId;

	const lowered = needle.toLowerCase();
	const partial = projects.filter((p) => p.name.toLowerCase().includes(lowered));
	if (partial.length === 1) return partial[0];
	if (partial.length > 1) return partial;
	return undefined;
}
