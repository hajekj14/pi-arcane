/**
 * `arcane_build` — build an image from the working tree, without deploying it.
 *
 * The tree is uploaded to the Arcane host first (plan-upload.md §7) and the
 * build runs against that directory. Nothing is cloned and nothing needs to be
 * committed or pushed: what is on disk is what gets built.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { ensureBaseImages, explainBuildFailure, parseBaseImages } from "../baseimages.ts";
import { detectTarget } from "../compose.ts";
import { readGitContext, sanitizeName } from "../git.ts";
import { requireRuntime, requireUpload } from "../runtime.ts";
import type { ImageBuildRecord } from "../types.ts";
import { collectFiles, contextSlug, formatBytes, syncContext } from "../upload.ts";
import { clampText, fields, toolError } from "./shared.ts";

const parameters = Type.Object({
	dockerfile_path: Type.Optional(
		Type.String({
			description:
				"Dockerfile path relative to the project root. Auto-detected when omitted.",
		}),
	),
	context_dir: Type.Optional(
		Type.String({
			description:
				"Directory to upload and build from, relative to the project root. Defaults to the project root.",
		}),
	),
	tags: Type.Optional(
		Type.Array(Type.String(), {
			description: "Image tags, e.g. [\"myapp:latest\"]. Defaults to <project>:<branch>.",
		}),
	),
	build_args: Type.Optional(
		Type.Record(Type.String(), Type.String(), { description: "Build-time ARG values." }),
	),
	no_cache: Type.Optional(Type.Boolean({ description: "Build without the layer cache." })),
	push: Type.Optional(Type.Boolean({ description: "Push the image after building. Default false." })),
	platforms: Type.Optional(
		Type.Array(Type.String(), { description: 'Target platforms, e.g. ["linux/amd64"].' }),
	),
	refresh: Type.Optional(
		Type.Boolean({
			description:
				"Re-upload every file instead of only what changed since the last upload.",
		}),
	),
});

export type ArcaneBuildInput = Static<typeof parameters>;

export function createBuildTool(): ToolDefinition<typeof parameters> {
	return defineTool({
		name: "arcane_build",
		label: "Arcane Build",
		description: [
			"Build a Docker image on the Arcane host from the current working tree.",
			"",
			"The tree is uploaded first, so uncommitted and untracked files are included and",
			"nothing has to be committed or pushed. Only files that changed since the last",
			"upload are sent. Returns the BuildKit output and the recorded build status.",
			"Use arcane_deploy to build and run in one step.",
		].join("\n"),
		promptSnippet: "Build a Docker image on Arcane from the local working tree (no git push needed)",
		parameters,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				const { client, environmentId } = await requireRuntime(ctx);
				const upload = await requireUpload(ctx);

				const git = await readGitContext(ctx.cwd, signal);
				// Relative to the working directory, not the repository root: a repo can
				// hold several apps and only one of them is being built.
				const contextRoot = params.context_dir
					? join(ctx.cwd, params.context_dir)
					: ctx.cwd;

				const detected = await detectTarget(contextRoot, contextRoot);
				const dockerfile = params.dockerfile_path ?? detected?.dockerfilePath ?? "Dockerfile";

				const baseName = sanitizeName(
					contextRoot.split(/[\\/]/).filter(Boolean).pop() ?? "app",
				);
				const branch = git?.branch;
				const tags = params.tags ?? [`${baseName}:${sanitizeName(branch ?? "latest")}`];

				// --- Upload ---------------------------------------------------------
				const files = await collectFiles(contextRoot, { signal });
				if (files.length === 0) {
					throw new Error(`Nothing to upload from ${contextRoot} — the directory is empty.`);
				}

				const slug = contextSlug(contextRoot, baseName);
				onUpdate?.({
					content: [{ type: "text", text: `Uploading ${files.length} files...` }],
					details: {},
				});

				const result = await syncContext({
					client,
					environmentId,
					config: upload,
					root: contextRoot,
					slug,
					files,
					refresh: params.refresh,
					signal,
					onProgress: (done, total) => {
						onUpdate?.({
							content: [{ type: "text", text: `Uploading ${done}/${total} files...` }],
							details: {},
						});
					},
				});

				// --- Pre-pull base images ---------------------------------------------
				// Arcane's builder cannot reach a registry on its own; see baseimages.ts.
				const baseImages = await readBaseImages(contextRoot, dockerfile, params.build_args);
				const pullReport = await ensureBaseImages(client, environmentId, baseImages, {
					signal,
					onProgress: (message) =>
						onUpdate?.({ content: [{ type: "text", text: message }], details: {} }),
				});

				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Uploaded ${result.uploaded} files (${formatBytes(result.bytes)}), ${result.unchanged} unchanged. Building ${tags.join(", ")}...`,
						},
					],
					details: {},
				});

				// --- Build -----------------------------------------------------------
				const buildsBefore = await client.listBuilds(environmentId, signal);
				const knownBuildIds = new Set(buildsBefore.map((b) => b.id));

				const output = await client.buildImage(
					environmentId,
					{
						contextDir: result.contextPath,
						dockerfile,
						tags,
						buildArgs: params.build_args,
						noCache: params.no_cache,
						push: params.push ?? false,
						load: !(params.push ?? false),
						platforms: params.platforms,
					},
					signal,
				);

				// The build endpoint streams progress rather than returning a record,
				// so pick up the resulting record afterwards for its status.
				let record: ImageBuildRecord | undefined;
				try {
					const after = await client.listBuilds(environmentId, signal);
					record = after.find((b) => !knownBuildIds.has(b.id)) ?? after[0];
				} catch {
					// Non-fatal: the streamed output is still the primary result.
				}

				const failed =
					/^ERROR|error:|"error"/im.test(output) ||
					(record !== undefined && /fail|error/i.test(record.status ?? ""));

				const summary = fields([
					["tags", tags.join(",")],
					["context", result.contextPath],
					["dockerfile", dockerfile],
					["uploaded", `${result.uploaded} files, ${formatBytes(result.bytes)}`],
					["unchanged", String(result.unchanged)],
					["status", record?.status ?? (failed ? "failed" : "unknown")],
					["buildId", record?.id],
					["digest", record?.digest],
					["duration", record?.durationMs ? `${Math.round(record.durationMs / 1000)}s` : undefined],
				]);

				const text = [
					failed ? "Image build FAILED." : "Image build finished.",
					summary,
					record?.errorMessage ? `error: ${record.errorMessage}` : "",
					explainBuildFailure(output, pullReport) ?? "",
					...pullReport.failed.map((f) => `warning: could not pull ${f.image}: ${f.error}`),
					...result.warnings.map((w) => `warning: ${w}`),
					"",
					"BuildKit output:",
					clampText(output.trim() || "(no output)"),
				]
					.filter(Boolean)
					.join("\n");

				if (failed) throw new Error(text);

				return {
					content: [{ type: "text", text }],
					details: { tags, buildId: record?.id, status: record?.status, upload: result, record },
				};
			} catch (error) {
				throw toolError(error);
			}
		},
	});
}

/**
 * Read the Dockerfile from the local tree to find its base images. Unreadable
 * means no pre-pull, not a failure: the build reports a missing Dockerfile far
 * better than this can.
 */
export async function readBaseImages(
	contextRoot: string,
	dockerfile: string,
	buildArgs?: Record<string, string>,
): Promise<string[]> {
	try {
		const content = await readFile(join(contextRoot, dockerfile), "utf8");
		return parseBaseImages(content, buildArgs);
	} catch {
		return [];
	}
}
