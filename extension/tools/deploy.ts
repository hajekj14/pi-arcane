/**
 * `arcane_deploy` — upload the working tree and run it (plan-upload.md §3, §7).
 *
 * The tree is pushed to the upload sidecar, which lands it in a directory the
 * Arcane container can read. From there two shapes are supported:
 *
 * - **compose** — the project has a compose file. Arcane gets a copy of it with
 *   every `build:` context rewritten to the uploaded path, so `up` builds from
 *   the uploaded tree.
 *
 * - **container** — only a Dockerfile. The image is built from the uploaded
 *   context and a generated one-service compose project runs it.
 *
 * Nothing is cloned and nothing needs to be pushed; uncommitted work deploys
 * exactly as it sits on disk. The local files are never modified.
 */

import { basename, join, posix } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { ensureBaseImages, explainBuildFailure } from "../baseimages.ts";
import { DEFAULT_CONTAINER_PORT, DEFAULT_HOST_PORT, parsePortMapping } from "../config.ts";
import {
	detectTarget,
	generateCompose,
	prepareCompose,
	readBuildDirectives,
	readComposeFile,
	rewriteBuildContexts,
	type PublishedPort,
} from "../compose.ts";
import { readBaseImages } from "./build.ts";
import { readGitContext, sanitizeName } from "../git.ts";
import { projectUiUrl, publicUrlsForContainer, requireRuntime, requireUpload } from "../runtime.ts";
import {
	DEPLOYMENT_ENTRY_TYPE,
	type ContainerSummary,
	type DeploymentRecord,
	type DeployShape,
	type ProjectDetails,
} from "../types.ts";
import {
	collectFiles,
	contextSlug,
	formatBytes,
	syncContext,
	type UploadResult,
} from "../upload.ts";
import { clampText, fields, toolError } from "./shared.ts";

const parameters = Type.Object({
	compose_path: Type.Optional(
		Type.String({
			description:
				"Compose file path relative to the project root. Auto-detected when omitted.",
		}),
	),
	project_name: Type.Optional(
		Type.String({
			description:
				"Arcane project name. Defaults to the project directory name, or the subdirectory name when deploying one.",
		}),
	),
	dockerfile: Type.Optional(
		Type.String({
			description: "Dockerfile path relative to the project root, for projects with no compose file.",
		}),
	),
	target_type: Type.Optional(
		StringEnum(["compose", "container"] as const, {
			description:
				"Force the deployment shape instead of detecting it. 'compose' deploys the compose file, building any service that declares build:; 'container' builds the Dockerfile and runs a generated one-service project.",
		}),
	),
	subdir: Type.Optional(
		Type.String({
			description:
				"Subdirectory to deploy, when the app is not at the project root. Only this subtree is uploaded.",
		}),
	),
	port_mapping: Type.Optional(
		Type.String({
			description: `Host:container port published for the primary service, e.g. "8080:80". Defaults to ${DEFAULT_HOST_PORT}:${DEFAULT_CONTAINER_PORT}. Only applied when the compose file publishes nothing.`,
		}),
	),
	build_args: Type.Optional(
		Type.Record(Type.String(), Type.String(), { description: "Build-time ARG values." }),
	),
	env_vars: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Environment variables for the generated service (container deploys only).",
		}),
	),
	refresh: Type.Optional(
		Type.Boolean({
			description: "Re-upload every file instead of only what changed since the last upload.",
		}),
	),
	force_recreate: Type.Optional(
		Type.Boolean({ description: "Recreate containers even when nothing changed." }),
	),
});

export type ArcaneDeployInput = Static<typeof parameters>;

export function createDeployTool(pi: ExtensionAPI): ToolDefinition<typeof parameters> {
	return defineTool({
		name: "arcane_deploy",
		label: "Arcane Deploy",
		description: [
			"Deploy the current working tree to Arcane and report where it is running.",
			"",
			"The tree is uploaded straight to the Arcane host — no git remote, no commit and no",
			"push are involved, so uncommitted and untracked files deploy exactly as they are on",
			"disk. Only files that changed since the last deploy are re-uploaded.",
			"",
			"Detects the deployment shape automatically:",
			"  compose   - a compose file exists: Arcane runs it, building any service that",
			"              declares build: from the uploaded tree.",
			"  container - only a Dockerfile exists: builds the image and runs it as a generated",
			"              one-service project.",
			"",
			"Returns the project status, containers, and the public URL of each running container.",
		].join("\n"),
		promptSnippet: "Upload the current working tree to Arcane and deploy it",
		promptGuidelines: [
			"Use arcane_deploy when the user asks to deploy, ship, or publish the current project to Arcane.",
			"No commit or push is needed first — the tool uploads the working tree as it is.",
		],
		parameters,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const progress: string[] = [];
			const step = (message: string) => {
				progress.push(message);
				onUpdate?.({ content: [{ type: "text", text: progress.join("\n") }], details: {} });
			};

			try {
				const { client, environmentId, config } = await requireRuntime(ctx);
				const upload = await requireUpload(ctx);
				const defaults = config.defaults;
				const warnings: string[] = [];

				// --- 1. What are we deploying, and from where? -----------------------
				// The upload root is the working directory, not the repository root: a
				// repo can hold several apps, and uploading the whole tree to deploy one
				// of them would be both wrong and slow.
				const git = await readGitContext(ctx.cwd, signal);
				const uploadRoot = params.subdir ? join(ctx.cwd, params.subdir) : ctx.cwd;

				const branch = git?.branch;
				step(`Source: ${uploadRoot}${branch ? ` (branch ${branch})` : ""}`);
				if (git?.dirty.dirty) {
					step(
						`Working tree is dirty (${git.dirty.modified} modified, ${git.dirty.untracked} untracked) — files are uploaded as they are on disk.`,
					);
				}

				const detected = await detectTarget(uploadRoot, uploadRoot);
				const composePath = params.compose_path ?? defaults.composePath ?? detected?.composePath;
				const dockerfilePath = params.dockerfile ?? detected?.dockerfilePath;
				const targetType: DeployShape =
					params.target_type ??
					defaults.targetType ??
					(composePath ? "compose" : dockerfilePath ? "container" : "compose");

				if (targetType === "compose" && !composePath) {
					throw new Error(
						`No compose file found in ${uploadRoot}. Add one, pass compose_path, or use target_type "container" with a Dockerfile.`,
					);
				}
				if (targetType === "container" && !dockerfilePath) {
					throw new Error(
						`No Dockerfile found in ${uploadRoot}. Add one or pass dockerfile explicitly.`,
					);
				}

				const projectName = sanitizeName(
					params.project_name ?? defaults.projectName ?? basename(uploadRoot),
				);
				step(
					`Target: ${targetType}${composePath ? ` (${composePath})` : dockerfilePath ? ` (${dockerfilePath})` : ""} → project "${projectName}"`,
				);

				// --- 2. Upload the tree ----------------------------------------------
				const files = await collectFiles(uploadRoot, { signal });
				if (files.length === 0) {
					throw new Error(`Nothing to upload from ${uploadRoot} — the directory is empty.`);
				}

				const slug = contextSlug(uploadRoot, projectName);
				step(`Uploading ${files.length} files...`);
				const uploaded = await syncContext({
					client,
					environmentId,
					config: upload,
					root: uploadRoot,
					slug,
					files,
					refresh: params.refresh,
					signal,
					onProgress: (done, total) => {
						progress[progress.length - 1] = `Uploading ${done}/${total} files...`;
						onUpdate?.({ content: [{ type: "text", text: progress.join("\n") }], details: {} });
					},
				});
				progress[progress.length - 1] =
					`Uploaded ${uploaded.uploaded} files (${formatBytes(uploaded.bytes)}), ${uploaded.unchanged} unchanged, ${uploaded.deleted} removed, in ${(uploaded.durationMs / 1000).toFixed(1)}s`;
				step(`Context: ${uploaded.contextPath}`);
				warnings.push(...uploaded.warnings);

				const record: DeploymentRecord = {
					timestamp: new Date().toISOString(),
					environmentId,
					projectName,
					branch,
					composePath,
					targetType,
					contextPath: uploaded.contextPath,
					upload: {
						uploaded: uploaded.uploaded,
						deleted: uploaded.deleted,
						unchanged: uploaded.unchanged,
						bytes: uploaded.bytes,
					},
					status: "failed",
				};

				// --- 3. Turn it into a running project --------------------------------
				let project: ProjectDetails | undefined;
				let portNote: string | undefined;
				let expectedPort: PublishedPort | undefined;

				if (targetType === "compose") {
					const result = await deployCompose({
						client,
						signal,
						step,
						environmentId,
						projectName,
						uploadRoot,
						composePath: composePath!,
						uploaded,
						portMapping: params.port_mapping ?? defaults.portMapping,
						forceRecreate: params.force_recreate,
					});
					project = result.project;
					portNote = result.portNote;
					expectedPort = result.expectedPort;
					warnings.push(...result.warnings);
				} else {
					const result = await deployImage({
						client,
						signal,
						step,
						environmentId,
						projectName,
						branch,
						uploadRoot,
						dockerfilePath: dockerfilePath!,
						uploaded,
						portMapping: params.port_mapping ?? defaults.portMapping,
						buildArgs: params.build_args,
						envVars: params.env_vars,
						forceRecreate: params.force_recreate,
					});
					project = result.project;
					expectedPort = result.expectedPort;
				}

				record.projectId = project?.id;

				// --- 4. Report ---------------------------------------------------------
				const containers = await client.listContainers(environmentId, signal);
				const projectContainers = containersForProject(containers, projectName);

				const endpoints = projectContainers.map((container) => {
					const name = (container.names ?? [])[0]?.replace(/^\//, "") ?? container.id.slice(0, 12);
					const published = (container.ports ?? []).filter((p) => p.publicPort);
					const urls =
						container.state === "running" ? publicUrlsForContainer(container.ports) : [];
					return {
						name,
						state: container.state,
						status: container.status,
						ports: published.map((p) => `${p.publicPort}->${p.privatePort}/${p.type}`),
						urls,
						url: urls[0],
					};
				});

				record.status = project && !/fail|error/i.test(project.status ?? "") ? "success" : "failed";
				record.containers = endpoints.map((e) => ({ name: e.name, state: e.state, url: e.url }));
				record.urls = endpoints.map((e) => e.url).filter((u): u is string => Boolean(u));
				pi.appendEntry(DEPLOYMENT_ENTRY_TYPE, record);

				const lines: string[] = [];
				lines.push(
					record.status === "success" ? "Deploy completed." : "Deploy finished with problems.",
				);
				lines.push(
					fields([
						["project", projectName],
						["projectId", project?.id],
						["status", project?.status],
						["services", project ? `${project.runningCount}/${project.serviceCount}` : undefined],
						["branch", branch],
						["context", uploaded.contextPath],
						[
							"upload",
							`${uploaded.uploaded} sent (${formatBytes(uploaded.bytes)}), ${uploaded.unchanged} unchanged, ${uploaded.deleted} removed`,
						],
					]),
				);
				if (project?.statusReason) lines.push(`reason: ${project.statusReason}`);
				if (portNote) lines.push(`ports: ${portNote}`);

				lines.push("");
				lines.push("Containers:");
				if (endpoints.length === 0) {
					lines.push("  (none running — check arcane_logs for build or startup errors)");
				}
				for (const endpoint of endpoints) {
					lines.push(
						`  ${endpoint.name}  ${fields([
							["state", endpoint.state],
							["ports", endpoint.ports.join(",")],
						])}`,
					);
					for (const url of endpoint.urls) lines.push(`    ${url}`);
					if (endpoint.state === "running" && endpoint.urls.length === 0) {
						lines.push(
							"    (publishes no host port, so it has no public URL — routing is by published port)",
						);
					}
				}

				// Say plainly when the deployment is up but unreachable, rather than
				// leaving the user to discover it by clicking a URL that fails.
				const publishedExpectedPort =
					expectedPort !== undefined &&
					endpoints.some((e) => e.ports.some((p) => p.startsWith(`${expectedPort!.host}->`)));

				if (expectedPort && endpoints.length > 0 && !publishedExpectedPort) {
					lines.push("");
					lines.push(
						`Note: expected host port ${expectedPort.host} to be published, but it is not. Public URLs are derived from the published host port.`,
					);
				}

				if (project) {
					lines.push("");
					lines.push(`Arcane UI: ${projectUiUrl(config.host, environmentId, project.id)}`);
				}

				if (warnings.length > 0) {
					lines.push("");
					lines.push("Warnings:");
					for (const warning of warnings) lines.push(`  - ${warning}`);
				}

				const text = lines.join("\n");
				if (record.status !== "success") throw new Error(text);

				return {
					content: [{ type: "text", text }],
					details: { record, project, endpoints, upload: uploaded },
				};
			} catch (error) {
				throw toolError(error);
			}
		},
	});
}

// ---------------------------------------------------------------------------
// compose → project built from the uploaded context
// ---------------------------------------------------------------------------

interface ComposeArgs {
	client: Awaited<ReturnType<typeof requireRuntime>>["client"];
	signal: AbortSignal | undefined;
	step: (message: string) => void;
	environmentId: string;
	projectName: string;
	uploadRoot: string;
	composePath: string;
	uploaded: UploadResult;
	portMapping?: string;
	forceRecreate?: boolean;
}

async function deployCompose(args: ComposeArgs): Promise<{
	project?: ProjectDetails;
	portNote?: string;
	expectedPort?: PublishedPort;
	warnings: string[];
}> {
	const {
		client,
		signal,
		step,
		environmentId,
		projectName,
		uploadRoot,
		composePath,
		uploaded,
		portMapping,
		forceRecreate,
	} = args;

	const warnings: string[] = [];
	const local = await readComposeFile(join(uploadRoot, composePath));
	if (!local) {
		throw new Error(`Could not read ${composePath} under ${uploadRoot}.`);
	}

	// Relative build contexts resolve against the compose file's directory, which
	// does not exist on the Arcane host — rewrite them onto the uploaded copy.
	const composeDir = composePath.includes("/")
		? composePath.slice(0, composePath.lastIndexOf("/"))
		: ".";
	const rewritten = rewriteBuildContexts(local, uploaded.contextPath, composeDir);
	if (rewritten.rewritten.length > 0) {
		step(
			`Build context for ${rewritten.rewritten.join(", ")} → ${uploaded.contextPath}`,
		);
	}

	// Compose builds during `up`, on the same builder with the same limitation,
	// so every service that builds needs its base images on the host first.
	const pullReport = await ensureBaseImages(
		client,
		environmentId,
		await composeBaseImages(local, uploadRoot, composeDir),
		{ signal, onProgress: step },
	);
	for (const failure of pullReport.failed) {
		warnings.push(`Could not pull ${failure.image}: ${failure.error}`);
	}

	// Only fill in a published port when the compose file publishes none; a repo
	// that declares its own ports is being deliberate.
	const wanted = parsePortMapping(portMapping ?? `${DEFAULT_HOST_PORT}:${DEFAULT_CONTAINER_PORT}`);
	const allocated = await allocateHostPort(client, environmentId, projectName, wanted.host, signal);
	if (allocated.moved) {
		step(`Host port ${wanted.host} is taken; using ${allocated.port} instead.`);
	}
	const patch = prepareCompose(rewritten.content, {
		portMapping: `${allocated.port}:${wanted.container}`,
	});
	const composeContent = patch.changed ? patch.content : rewritten.content;

	const projects = await client.listProjects(environmentId, signal);
	const existing = projects.find((p) => p.name === projectName);

	let project: ProjectDetails;
	if (existing) {
		project = await client.updateProject(environmentId, existing.id, { composeContent }, signal);
		step(`Project updated: ${project.name} (${project.id})`);
	} else {
		const created = await client.createProject(
			environmentId,
			{ name: projectName, composeContent },
			signal,
		);
		step(`Project created: ${created.name} (${created.id})`);
		project = await client.getProject(environmentId, created.id, signal);
	}

	step("Deploying project (compose builds from the uploaded context)...");
	let output: string;
	try {
		output = await client.deployProject(
			environmentId,
			project.id,
			// The context path is stable across deploys, so without forceRecreate
			// compose would keep a container built from an older upload.
			{ forceRecreate: forceRecreate ?? true },
			signal,
		);
	} catch (error) {
		const explanation = explainBuildFailure((error as Error).message, pullReport);
		throw explanation ? new Error(`${(error as Error).message}\n\n${explanation}`) : error;
	}
	const explained = explainBuildFailure(output, pullReport);
	if (explained) warnings.push(explained);
	if (output.trim()) step(clampText(output.trim(), 2000));

	project = await waitForProjectSettled(client, environmentId, project.id, signal, step);

	return { project, portNote: patch.notes.join("; "), expectedPort: patch.effectivePort, warnings };
}

/**
 * Base images of every service the compose file builds.
 *
 * Each service's Dockerfile is read from the local tree — the same bytes that
 * were just uploaded — resolving its context relative to the compose file.
 */
async function composeBaseImages(
	composeContent: string,
	uploadRoot: string,
	composeDir: string,
): Promise<string[]> {
	const images: string[] = [];

	for (const directive of readBuildDirectives(composeContent)) {
		// An absolute context lives on the Arcane host, not here; nothing to read.
		if (directive.context.startsWith("/")) continue;
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(directive.context)) continue;

		const relative = posix.normalize(
			posix.join(composeDir === "." ? "" : composeDir, directive.context),
		);
		const contextRoot = join(uploadRoot, relative);
		images.push(...(await readBaseImages(contextRoot, directive.dockerfile, directive.args)));
	}

	return [...new Set(images)];
}

// ---------------------------------------------------------------------------
// Dockerfile → image build → generated project
// ---------------------------------------------------------------------------

interface ImageArgs {
	client: Awaited<ReturnType<typeof requireRuntime>>["client"];
	signal: AbortSignal | undefined;
	step: (message: string) => void;
	environmentId: string;
	projectName: string;
	branch?: string;
	/** Local directory that was uploaded, for reading the Dockerfile back. */
	uploadRoot: string;
	dockerfilePath: string;
	uploaded: UploadResult;
	portMapping?: string;
	buildArgs?: Record<string, string>;
	envVars?: Record<string, string>;
	forceRecreate?: boolean;
}

async function deployImage(args: ImageArgs): Promise<{
	project?: ProjectDetails;
	expectedPort?: PublishedPort;
}> {
	const {
		client,
		signal,
		step,
		environmentId,
		projectName,
		branch,
		uploadRoot,
		dockerfilePath,
		uploaded,
		portMapping,
		buildArgs,
		envVars,
		forceRecreate,
	} = args;

	const tag = `${projectName}:${sanitizeName(branch ?? "latest")}`;

	// Arcane's builder cannot fetch base images itself; see baseimages.ts.
	const pullReport = await ensureBaseImages(
		client,
		environmentId,
		await readBaseImages(uploadRoot, dockerfilePath, buildArgs),
		{ signal, onProgress: step },
	);

	step(`Building ${tag} from ${uploaded.contextPath}...`);
	const output = await client.buildImage(
		environmentId,
		{
			contextDir: uploaded.contextPath,
			dockerfile: dockerfilePath,
			tags: [tag],
			buildArgs,
			load: true,
			push: false,
		},
		signal,
	);
	if (/^ERROR|error:|"error"/im.test(output)) {
		const explanation = explainBuildFailure(output, pullReport);
		throw new Error(
			[`Image build failed:`, explanation, clampText(output.trim(), 8000)]
				.filter(Boolean)
				.join("\n"),
		);
	}
	step(`Built ${tag}.`);

	const wanted = parsePortMapping(portMapping ?? `${DEFAULT_HOST_PORT}:${DEFAULT_CONTAINER_PORT}`);
	const allocated = await allocateHostPort(client, environmentId, projectName, wanted.host, signal);
	if (allocated.moved) {
		step(`Host port ${wanted.host} is taken; using ${allocated.port} instead.`);
	}
	const host = allocated.port;
	const container = wanted.container;

	const composeContent = generateCompose({
		serviceName: "web",
		image: tag,
		portMapping: `${host}:${container}`,
		env: envVars,
	});

	const projects = await client.listProjects(environmentId, signal);
	const existing = projects.find((p) => p.name === projectName);

	let project: ProjectDetails;
	if (existing) {
		project = await client.updateProject(environmentId, existing.id, { composeContent }, signal);
		step(`Project updated: ${project.name} (${project.id})`);
	} else {
		const created = await client.createProject(
			environmentId,
			{ name: projectName, composeContent },
			signal,
		);
		step(`Project created: ${created.name} (${created.id})`);
		project = await client.getProject(environmentId, created.id, signal);
	}

	step("Deploying project...");
	// forceRecreate defaults to true here: the image tag is stable across
	// deploys, so without it Docker would keep the old container.
	const deployOutput = await client.deployProject(
		environmentId,
		project.id,
		{ forceRecreate: forceRecreate ?? true },
		signal,
	);
	if (deployOutput.trim()) step(clampText(deployOutput.trim(), 2000));

	project = await waitForProjectSettled(client, environmentId, project.id, signal, step);

	return { project, expectedPort: { host, container } };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Wait until the project stops reporting an in-flight activity.
 *
 * `up` streams its output and returns when compose is done, but Arcane may
 * still be finalising an activity record; polling that gives a trustworthy
 * final status and surfaces the failure message when there is one.
 */
async function waitForProjectSettled(
	client: ImageArgs["client"],
	environmentId: string,
	projectId: string,
	signal: AbortSignal | undefined,
	step: (message: string) => void,
): Promise<ProjectDetails> {
	let project = await client.getProject(environmentId, projectId, signal);

	if (project.activityId) {
		const outcome = await client.waitForActivity(environmentId, project.activityId, {
			signal,
			timeoutMs: 20 * 60_000,
			onProgress: (_activity, messages) => {
				for (const message of messages.slice(-3)) step(`  ${message}`);
			},
		});
		if (outcome.timedOut) {
			step("Activity did not finish within the timeout and was cancelled.");
		} else if (!outcome.ok) {
			step(`Activity finished as ${outcome.activity.status}: ${outcome.activity.error ?? ""}`);
		}
		project = await client.getProject(environmentId, projectId, signal);
	}

	return project;
}

/**
 * Pick a free host port for this project, starting at `preferred`.
 *
 * Two projects cannot bind the same host port, so a second deployment with the
 * default 5553 fails with "port is already allocated". Ports already held by
 * *this* project are not treated as taken, so redeploys keep a stable port
 * instead of drifting upward on every run.
 */
async function allocateHostPort(
	client: ImageArgs["client"],
	environmentId: string,
	projectName: string,
	preferred: string,
	signal: AbortSignal | undefined,
): Promise<{ port: string; moved: boolean }> {
	const start = Number.parseInt(preferred, 10);
	if (!Number.isFinite(start)) return { port: preferred, moved: false };

	let containers: ContainerSummary[];
	try {
		containers = await client.listContainers(environmentId, signal);
	} catch {
		// If the list is unavailable, use the preferred port and let Docker be
		// the authority on whether it is free.
		return { port: preferred, moved: false };
	}

	const ours = new Set(containersForProject(containers, projectName).map((c) => c.id));
	const taken = new Set<number>();
	for (const container of containers) {
		if (ours.has(container.id)) continue;
		for (const port of container.ports ?? []) {
			if (port.publicPort) taken.add(port.publicPort);
		}
	}

	// Stay inside the range the routing vhost accepts (see nginx/pi-arcane.conf);
	// a port outside it would deploy fine but have no working URL.
	const limit = start === Number.parseInt(DEFAULT_HOST_PORT, 10) ? 5599 : start + 20;
	for (let candidate = start; candidate <= limit; candidate += 1) {
		if (!taken.has(candidate)) {
			return { port: String(candidate), moved: candidate !== start };
		}
	}
	return { port: preferred, moved: false };
}

/** Match by the compose project label Docker sets, falling back to name prefix. */
function containersForProject(
	containers: ContainerSummary[],
	projectName: string,
): ContainerSummary[] {
	const labelled = containers.filter(
		(c) => c.labels?.["com.docker.compose.project"] === projectName,
	);
	if (labelled.length > 0) return labelled;
	return containers.filter((c) =>
		(c.names ?? []).some((raw) => {
			const name = raw.replace(/^\//, "");
			return (
				name === projectName ||
				name.startsWith(`${projectName}-`) ||
				name.startsWith(`${projectName}_`)
			);
		}),
	);
}
