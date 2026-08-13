/**
 * `arcane_deploy` — the develop → deploy workflow (plan phase 3.1).
 *
 * Two shapes are supported:
 *
 * - **compose** — the repo has a compose file. A GitOps sync points Arcane at
 *   the repo/branch/compose path and `sync` makes Arcane pull and apply it.
 *
 * - **container** — the repo only has a Dockerfile. Arcane's project model is
 *   compose-based and a GitOps sync needs a compose file that exists in the
 *   repo, so instead the image is built from the git remote and a generated
 *   one-service compose project runs it (plan 6.3). The repo is never modified.
 */

import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { DEFAULT_CONTAINER_PORT, DEFAULT_HOST_PORT, parsePortMapping } from "../config.ts";
import {
	detectTarget,
	generateCompose,
	prepareCompose,
	readComposeFile,
	type PublishedPort,
} from "../compose.ts";
import { branchExistsOnRemote, isBranchPushed, readGitContext, sanitizeName } from "../git.ts";
import { buildKitContext, registerRepository, resolveRepo } from "../repo.ts";
import {
	projectUiUrl,
	publicUrlForContainer,
	requireRuntime,
	routableContainerName,
	unroutableReason,
} from "../runtime.ts";
import {
	DEPLOYMENT_ENTRY_TYPE,
	type ContainerSummary,
	type DeploymentRecord,
	type GitOpsSync,
	type ProjectDetails,
	type SyncTargetType,
} from "../types.ts";
import { clampText, fields, toolError } from "./shared.ts";

const parameters = Type.Object({
	git_url: Type.Optional(
		Type.String({
			description:
				"Repository URL Arcane should clone. Defaults to the local 'origin' remote, converted to HTTPS.",
		}),
	),
	branch: Type.Optional(
		Type.String({ description: "Branch to deploy. Defaults to the current branch." }),
	),
	compose_path: Type.Optional(
		Type.String({
			description:
				"Compose file path relative to the repository root. Auto-detected when omitted.",
		}),
	),
	project_name: Type.Optional(
		Type.String({
			description:
				"Arcane project name. Defaults to the repository name, or the subdirectory name when the compose file is not at the repo root.",
		}),
	),
	sync_name: Type.Optional(
		Type.String({ description: "GitOps sync name. Defaults to '<project>-<branch>'." }),
	),
	dockerfile: Type.Optional(
		Type.String({
			description:
				"Dockerfile path relative to the repository root, for repos without a compose file.",
		}),
	),
	target_type: Type.Optional(
		StringEnum(["compose", "container"] as const, {
			description:
				"Force the deployment shape instead of detecting it. 'compose' uses a GitOps sync; 'container' builds the Dockerfile and runs a generated one-service project.",
		}),
	),
	subdir: Type.Optional(
		Type.String({
			description:
				"Subdirectory of the repository to deploy, when the app is not at the repo root.",
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
	auto_sync: Type.Optional(
		Type.Boolean({
			description:
				"Let Arcane poll the branch and redeploy on its own. Default false (manual, CI-style deploys).",
		}),
	),
	sync_interval: Type.Optional(
		Type.Integer({ minimum: 10, description: "Seconds between polls when auto_sync is on." }),
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
			"Deploy the current repository to Arcane and report where it is running.",
			"",
			"Arcane clones from the git remote, so the branch must be pushed first — the tool",
			"checks and refuses to deploy stale or unpushed work rather than silently",
			"deploying something older than the working tree.",
			"",
			"Detects the deployment shape automatically:",
			"  compose   - a compose file exists: registers the repo, creates/updates a GitOps",
			"              sync, and syncs it so Arcane pulls and applies the compose file.",
			"  container - only a Dockerfile exists: builds the image from the git remote and",
			"              runs it as a generated one-service project. The repo is not modified.",
			"",
			"Returns the project status, containers, and the public URL of each running container.",
		].join("\n"),
		promptSnippet:
			"Deploy the current repo to Arcane (GitOps sync for compose repos, image build for Dockerfile-only repos)",
		promptGuidelines: [
			"Use arcane_deploy when the user asks to deploy, ship, or publish the current project to Arcane.",
			"Commit and push before calling arcane_deploy — Arcane deploys from the git remote, not the working tree.",
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
				const defaults = config.defaults;

				// --- 1/2. Repository and branch -------------------------------------
				const git = await readGitContext(ctx.cwd, signal);
				if (!git) {
					throw new Error(
						`${ctx.cwd} is not inside a git repository. Arcane deploys from a git remote, so the project must be a repo with a pushed branch.`,
					);
				}

				const branch = params.branch ?? git.branch;
				if (!branch) {
					throw new Error(
						"Could not determine the current branch (detached HEAD?). Pass branch explicitly.",
					);
				}

				const warnings: string[] = [];
				if (git.dirty) {
					warnings.push(
						"The working tree has uncommitted changes; Arcane deploys the pushed commit, not your local edits.",
					);
				}
				if (!(await branchExistsOnRemote(git.repoRoot, branch, "origin", signal))) {
					throw new Error(
						`Branch "${branch}" does not exist on origin. Push it first — Arcane clones the branch from the remote.`,
					);
				}
				if (!(await isBranchPushed(git.repoRoot, branch, "origin", signal))) {
					warnings.push(
						`Local "${branch}" is ahead of origin/${branch}; Arcane will deploy the commit currently on the remote.`,
					);
				}

				step(`Repository: ${git.repoRoot}`);
				step(`Branch: ${branch}${git.commit ? ` @ ${git.commit.slice(0, 8)}` : ""}`);

				// --- 3. What are we deploying? --------------------------------------
				const searchDir = params.subdir ? join(git.repoRoot, params.subdir) : ctx.cwd;
				const detected = await detectTarget(git.repoRoot, searchDir);

				const composePath =
					params.compose_path ?? defaults.composePath ?? detected?.composePath;
				const dockerfilePath = params.dockerfile ?? detected?.dockerfilePath;
				const targetType: SyncTargetType =
					params.target_type ??
					defaults.targetType ??
					(composePath ? "compose" : dockerfilePath ? "container" : ("compose" as const));

				if (targetType === "compose" && !composePath) {
					throw new Error(
						`No compose file found in ${searchDir}. Add one, pass compose_path, or use target_type "container" with a Dockerfile.`,
					);
				}
				if (targetType === "container" && !dockerfilePath) {
					throw new Error(
						`No Dockerfile found in ${searchDir}. Add one or pass dockerfile explicitly.`,
					);
				}

				const contextDir = detected?.contextDir ?? params.subdir ?? ".";
				const repoBaseName = sanitizeName(
					(git.parsedRemote?.path.split("/").filter(Boolean).pop() ??
						basename(git.repoRoot)) as string,
				);
				// A repo can hold several apps; name the project after the subdirectory
				// when the app is not at the root, so deployments do not collide.
				const projectName = sanitizeName(
					params.project_name ??
						defaults.projectName ??
						(contextDir === "." ? repoBaseName : basename(contextDir)),
				);
				const syncName =
					params.sync_name ?? defaults.syncName ?? `${projectName}-${sanitizeName(branch)}`;

				step(
					`Target: ${targetType}${composePath ? ` (${composePath})` : dockerfilePath ? ` (${dockerfilePath})` : ""} → project "${projectName}"`,
				);

				// --- 4. Register the repository in Arcane ---------------------------
				const resolved = await resolveRepo(ctx, git, params.git_url);
				const registration = await registerRepository(client, resolved, repoBaseName, signal);
				step(
					`Repository in Arcane: ${registration.repository.name} (${registration.repository.id}) — ${
						registration.created ? "created" : registration.updated ? "credentials updated" : "reused"
					}`,
				);
				if (resolved.tokenSource) step(`Auth: token from ${resolved.tokenSource}`);

				const record: DeploymentRecord = {
					timestamp: new Date().toISOString(),
					environmentId,
					projectName,
					branch,
					composePath,
					targetType,
					repositoryId: registration.repository.id,
					status: "failed",
				};

				let project: ProjectDetails | undefined;
				let portNote: string | undefined;
				let expectedPort: PublishedPort | undefined;
				let expectedContainer: string | undefined;

				if (targetType === "compose") {
					const result = await deployViaGitOps({
						client,
						ctx,
						signal,
						step,
						environmentId,
						repositoryId: registration.repository.id,
						syncName,
						projectName,
						branch,
						composePath: composePath!,
						repoRoot: git.repoRoot,
						portMapping: params.port_mapping ?? defaults.portMapping,
						autoSync: params.auto_sync ?? defaults.autoSync ?? false,
						syncInterval: params.sync_interval ?? defaults.syncInterval,
						forceRecreate: params.force_recreate,
					});
					project = result.project;
					portNote = result.portNote;
					expectedPort = result.expectedPort;
					expectedContainer = result.expectedContainer;
					record.syncId = result.sync.id;
					record.syncName = result.sync.name;
					warnings.push(...result.warnings);
				} else {
					const result = await deployViaImageBuild({
						client,
						signal,
						step,
						environmentId,
						projectName,
						branch,
						contextDir,
						dockerfilePath: dockerfilePath!,
						resolved,
						portMapping: params.port_mapping ?? defaults.portMapping,
						buildArgs: params.build_args,
						envVars: params.env_vars,
						forceRecreate: params.force_recreate,
					});
					project = result.project;
					expectedPort = result.expectedPort;
					expectedContainer = result.expectedContainer;
				}

				record.projectId = project?.id;

				// --- 8. Report ------------------------------------------------------
				const containers = await client.listContainers(environmentId, signal);
				const projectContainers = containersForProject(containers, projectName);

				const endpoints = projectContainers.map((container) => {
					const name = (container.names ?? [])[0]?.replace(/^\//, "") ?? container.id.slice(0, 12);
					const published = (container.ports ?? []).filter((p) => p.publicPort);
					return {
						name,
						state: container.state,
						status: container.status,
						ports: published.map((p) => `${p.publicPort}->${p.privatePort}/${p.type}`),
						url: container.state === "running" ? publicUrlForContainer(name) : undefined,
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
						["commit", project?.lastSyncCommit?.slice(0, 8)],
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
					if (endpoint.url) lines.push(`    ${endpoint.url}`);
					else if (endpoint.state === "running")
						lines.push(`    (${unroutableReason(endpoint.name)})`);
				}

				// Say plainly when the deployment is up but unreachable, rather than
				// leaving the user to discover it by clicking a URL that 502s.
				const publishedExpectedPort =
					expectedPort !== undefined &&
					endpoints.some((e) => e.ports.some((p) => p.startsWith(`${expectedPort!.host}->`)));

				if (expectedPort && endpoints.length > 0 && !publishedExpectedPort) {
					lines.push("");
					lines.push(
						`Note: nothing is published on host port ${expectedPort.host}. The t-*.${"hajek.click"} vhost proxies to that port, so the public URL will not work.`,
					);
				}
				if (expectedContainer && !endpoints.some((e) => e.name === expectedContainer)) {
					lines.push("");
					lines.push(
						`Note: expected a container named "${expectedContainer}" but none appeared; the public URL is derived from that name.`,
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
					details: { record, project, endpoints },
				};
			} catch (error) {
				throw toolError(error);
			}
		},
	});
}

// ---------------------------------------------------------------------------
// compose → GitOps sync
// ---------------------------------------------------------------------------

interface GitOpsArgs {
	client: Awaited<ReturnType<typeof requireRuntime>>["client"];
	ctx: Parameters<ToolDefinition["execute"]>[4];
	signal: AbortSignal | undefined;
	step: (message: string) => void;
	environmentId: string;
	repositoryId: string;
	syncName: string;
	projectName: string;
	branch: string;
	composePath: string;
	repoRoot: string;
	portMapping?: string;
	autoSync: boolean;
	syncInterval?: number;
	forceRecreate?: boolean;
}

async function deployViaGitOps(args: GitOpsArgs): Promise<{
	sync: GitOpsSync;
	project?: ProjectDetails;
	portNote?: string;
	expectedPort?: PublishedPort;
	expectedContainer?: string;
	warnings: string[];
}> {
	const {
		client,
		signal,
		step,
		environmentId,
		repositoryId,
		syncName,
		projectName,
		branch,
		composePath,
		repoRoot,
		portMapping,
		autoSync,
		syncInterval,
		forceRecreate,
	} = args;

	const warnings: string[] = [];

	// Inspect the local copy of the compose file so the report can say what will
	// actually be published, before Arcane has pulled anything.
	const localCompose = await readComposeFile(join(repoRoot, composePath));
	let expectedPort: PublishedPort | undefined;
	let portNote: string | undefined;
	let patchedCompose: string | undefined;
	let expectedContainer: string | undefined;

	if (localCompose) {
		const patch = prepareCompose(localCompose, {
			portMapping,
			routableName: routableContainerName(projectName),
		});
		expectedPort = patch.effectivePort;
		expectedContainer = patch.containerName;
		portNote = patch.notes.join("; ");
		if (patch.changed) {
			patchedCompose = patch.content;
			if (autoSync) {
				warnings.push(
					"auto_sync is on, so the next automatic sync will overwrite these in-Arcane compose edits. Put the ports and container_name in the committed compose file to make them stick.",
				);
			}
		}
	} else {
		warnings.push(
			`Could not read ${composePath} locally, so ports and container naming were left entirely to the committed file.`,
		);
	}

	// --- 5. Create or update the sync ---------------------------------------
	const existingSyncs = await client.listGitOpsSyncs(environmentId, signal);
	const existing =
		existingSyncs.find((sync) => sync.name === syncName) ??
		existingSyncs.find(
			(sync) =>
				sync.repositoryId === repositoryId &&
				sync.branch === branch &&
				sync.composePath === composePath,
		);

	let sync: GitOpsSync;
	if (existing) {
		sync = await client.updateGitOpsSync(
			environmentId,
			existing.id,
			{
				name: syncName,
				repositoryId,
				branch,
				composePath,
				projectName,
				targetType: "compose",
				autoSync,
				syncInterval: syncInterval ?? existing.syncInterval,
			},
			signal,
		);
		step(`GitOps sync updated: ${sync.name} (${sync.id})`);
	} else {
		sync = await client.createGitOpsSync(
			environmentId,
			{
				name: syncName,
				repositoryId,
				branch,
				composePath,
				projectName,
				targetType: "compose",
				autoSync,
				syncInterval: syncInterval ?? 60,
			},
			signal,
		);
		step(`GitOps sync created: ${sync.name} (${sync.id})`);
	}

	// --- 6. Trigger the sync -------------------------------------------------
	step("Syncing from git (Arcane clones the repo and applies the compose file)...");
	const result = await client.syncNow(environmentId, sync.id, signal);
	if (!result.success) {
		throw new Error(
			`GitOps sync failed: ${result.error ?? result.message ?? "no detail returned"}`,
		);
	}
	step(`Sync: ${result.message}`);

	// Re-read to pick up projectId and the applied commit.
	sync = await client.getGitOpsSync(environmentId, sync.id, signal);
	if (sync.lastSyncError) warnings.push(`Last sync reported: ${sync.lastSyncError}`);

	let project = await findProject(client, environmentId, sync.projectId, projectName, signal);
	if (!project) {
		throw new Error(
			`The sync succeeded but no project named "${projectName}" appeared in Arcane. Check the sync's compose path (${composePath}).`,
		);
	}

	// --- 7. Apply the port patch, if the repo compose published nothing ------
	if (patchedCompose) {
		try {
			project = await client.updateProject(
				environmentId,
				project.id,
				{ composeContent: patchedCompose },
				signal,
			);
			step(`Patched Arcane's compose copy: ${portNote}`);
		} catch (error) {
			warnings.push(`Could not patch the compose file in Arcane: ${(error as Error).message}`);
			expectedContainer = undefined;
		}
	}

	// --- 7b. Make sure it is actually up ------------------------------------
	step("Deploying project...");
	const output = await client.deployProject(
		environmentId,
		project.id,
		{ forceRecreate: forceRecreate ?? false },
		signal,
	);
	if (output.trim()) step(clampText(output.trim(), 2000));

	project = await waitForProjectSettled(client, environmentId, project.id, signal, step);

	return { sync, project, portNote, expectedPort, expectedContainer, warnings };
}

// ---------------------------------------------------------------------------
// Dockerfile → image build → generated project
// ---------------------------------------------------------------------------

interface ImageBuildArgs {
	client: Awaited<ReturnType<typeof requireRuntime>>["client"];
	signal: AbortSignal | undefined;
	step: (message: string) => void;
	environmentId: string;
	projectName: string;
	branch: string;
	contextDir: string;
	dockerfilePath: string;
	resolved: Awaited<ReturnType<typeof resolveRepo>>;
	portMapping?: string;
	buildArgs?: Record<string, string>;
	envVars?: Record<string, string>;
	forceRecreate?: boolean;
}

async function deployViaImageBuild(args: ImageBuildArgs): Promise<{
	project?: ProjectDetails;
	expectedPort?: PublishedPort;
	expectedContainer?: string;
}> {
	const {
		client,
		signal,
		step,
		environmentId,
		projectName,
		branch,
		contextDir,
		dockerfilePath,
		resolved,
		portMapping,
		buildArgs,
		envVars,
		forceRecreate,
	} = args;

	const tag = `${projectName}:${sanitizeName(branch)}`;
	const contextRef = buildKitContext(resolved, branch, contextDir);
	const dockerfileInContext =
		contextDir === "." ? dockerfilePath : dockerfilePath.replace(`${contextDir}/`, "");

	step(`Building ${tag} from ${resolved.displayUrl}#${branch}...`);
	const output = await client.buildImage(
		environmentId,
		{
			contextDir: contextRef,
			dockerfile: dockerfileInContext,
			tags: [tag],
			buildArgs,
			load: true,
			push: false,
		},
		signal,
	);
	if (/^ERROR|error:/im.test(output)) {
		throw new Error(`Image build failed:\n${clampText(output.trim(), 8000)}`);
	}
	step(`Built ${tag}.`);

	// The generated compose runs the freshly built image; the repo is untouched.
	const containerName = routableContainerName(projectName);
	const composeContent = generateCompose({
		serviceName: "web",
		image: tag,
		portMapping,
		env: envVars,
		containerName,
	});
	const { host, container } = parsePortMapping(
		portMapping ?? `${DEFAULT_HOST_PORT}:${DEFAULT_CONTAINER_PORT}`,
	);

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

	return { project, expectedPort: { host, container }, expectedContainer: containerName };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function findProject(
	client: ImageBuildArgs["client"],
	environmentId: string,
	projectId: string | undefined,
	projectName: string,
	signal: AbortSignal | undefined,
): Promise<ProjectDetails | undefined> {
	if (projectId) {
		try {
			return await client.getProject(environmentId, projectId, signal);
		} catch {
			// Fall through to a name lookup — the recorded ID may be stale.
		}
	}
	const projects = await client.listProjects(environmentId, signal);
	return projects.find((p) => p.id === projectId) ?? projects.find((p) => p.name === projectName);
}

/**
 * Wait until the project stops reporting an in-flight activity.
 *
 * `up` streams its output and returns when compose is done, but Arcane may
 * still be finalising an activity record; polling that gives a trustworthy
 * final status and surfaces the failure message when there is one.
 */
async function waitForProjectSettled(
	client: ImageBuildArgs["client"],
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
