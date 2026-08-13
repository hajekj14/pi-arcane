/**
 * `arcane_build` — build an image without deploying it (plan phase 3.3).
 *
 * The build runs on the Arcane host, so the context has to be something that
 * host can reach: a git reference built from the repository's remote
 * (plan 6.3), not a local directory.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { detectTarget } from "../compose.ts";
import { readGitContext, sanitizeName } from "../git.ts";
import { buildKitContext, registerRepository, resolveRepo } from "../repo.ts";
import { requireRuntime } from "../runtime.ts";
import type { ImageBuildRecord } from "../types.ts";
import { clampText, fields, toolError } from "./shared.ts";

const parameters = Type.Object({
	dockerfile_path: Type.Optional(
		Type.String({
			description:
				"Dockerfile path relative to the repository root. Auto-detected when omitted.",
		}),
	),
	context_dir: Type.Optional(
		Type.String({
			description:
				"Build context directory relative to the repository root. Defaults to the repository root.",
		}),
	),
	tags: Type.Optional(
		Type.Array(Type.String(), {
			description: "Image tags, e.g. [\"myapp:latest\"]. Defaults to <repo-name>:<branch>.",
		}),
	),
	build_args: Type.Optional(
		Type.Record(Type.String(), Type.String(), { description: "Build-time ARG values." }),
	),
	branch: Type.Optional(
		Type.String({ description: "Branch to build from. Defaults to the current branch." }),
	),
	git_url: Type.Optional(
		Type.String({ description: "Override the repository URL Arcane builds from." }),
	),
	no_cache: Type.Optional(Type.Boolean({ description: "Build without the layer cache." })),
	push: Type.Optional(Type.Boolean({ description: "Push the image after building. Default false." })),
	platforms: Type.Optional(
		Type.Array(Type.String(), { description: 'Target platforms, e.g. ["linux/amd64"].' }),
	),
});

export type ArcaneBuildInput = Static<typeof parameters>;

export function createBuildTool(): ToolDefinition<typeof parameters> {
	return defineTool({
		name: "arcane_build",
		label: "Arcane Build",
		description: [
			"Build a Docker image on the Arcane host without deploying it.",
			"",
			"The image is built from the repository's git remote at the given branch, so the",
			"branch must already be pushed. Returns the BuildKit output and the recorded",
			"build status. Use arcane_deploy to actually run the result.",
		].join("\n"),
		promptSnippet: "Build a Docker image on Arcane from the repo's git remote, without deploying",
		parameters,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				const { client, environmentId } = await requireRuntime(ctx);

				const git = await readGitContext(ctx.cwd, signal);
				if (!git) {
					throw new Error(
						`${ctx.cwd} is not inside a git repository. arcane_build builds from a git remote.`,
					);
				}

				const branch = params.branch ?? git.branch;
				if (!branch) {
					throw new Error("Could not determine the branch to build. Pass branch explicitly.");
				}

				const resolved = await resolveRepo(ctx, git, params.git_url);
				// Registering is not strictly required for an image build, but it keeps
				// the repo visible in Arcane and validates the credentials early.
				await registerRepository(client, resolved, undefined, signal);

				const detected = await detectTarget(git.repoRoot, git.repoRoot);
				const contextSubdir = params.context_dir?.replace(/^\.\//, "") ?? ".";
				const dockerfile =
					params.dockerfile_path ?? detected?.dockerfilePath ?? "Dockerfile";

				const repoName = sanitizeName(
					resolved.parsed.path.split("/").filter(Boolean).pop() ?? "app",
				);
				const tags = params.tags ?? [`${repoName}:${sanitizeName(branch)}`];

				const contextRef = buildKitContext(resolved, branch, contextSubdir);

				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Building ${tags.join(", ")} from ${resolved.displayUrl}#${branch}...`,
						},
					],
					details: {},
				});

				const buildsBefore = await client.listBuilds(environmentId, signal);
				const knownBuildIds = new Set(buildsBefore.map((b) => b.id));

				const output = await client.buildImage(
					environmentId,
					{
						contextDir: contextRef,
						// Relative to the context subdirectory once BuildKit has cloned it.
						dockerfile: relativeToContext(dockerfile, contextSubdir),
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
					record !== undefined && /fail|error/i.test(record.status ?? "");

				const summary = fields([
					["tags", tags.join(",")],
					["context", `${resolved.displayUrl}#${branch}${contextSubdir === "." ? "" : `:${contextSubdir}`}`],
					["dockerfile", dockerfile],
					["status", record?.status ?? "unknown"],
					["buildId", record?.id],
					["digest", record?.digest],
					["duration", record?.durationMs ? `${Math.round(record.durationMs / 1000)}s` : undefined],
				]);

				const text = [
					failed ? "Image build FAILED." : "Image build finished.",
					summary,
					record?.errorMessage ? `error: ${record.errorMessage}` : "",
					"",
					"BuildKit output:",
					clampText(output.trim() || "(no output)"),
				]
					.filter(Boolean)
					.join("\n");

				if (failed) throw new Error(text);

				return {
					content: [{ type: "text", text }],
					details: { tags, buildId: record?.id, status: record?.status, record },
				};
			} catch (error) {
				throw toolError(error);
			}
		},
	});
}

/**
 * BuildKit clones the context and treats the subdirectory as the root, so a
 * repo-root-relative Dockerfile path has to be rebased onto it.
 */
function relativeToContext(dockerfile: string, contextSubdir: string): string {
	if (contextSubdir === "." || contextSubdir === "") return dockerfile;
	const prefix = contextSubdir.endsWith("/") ? contextSubdir : `${contextSubdir}/`;
	return dockerfile.startsWith(prefix) ? dockerfile.slice(prefix.length) : dockerfile;
}
