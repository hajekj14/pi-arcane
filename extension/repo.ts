/**
 * Turning a local checkout into something Arcane can clone (plan phase 6.1).
 *
 * Arcane clones from the remote, so a deploy needs a reachable URL plus
 * credentials. Tokens are looked up in the environment first and only prompted
 * for interactively as a fallback; they are never written to disk by this
 * extension.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArcaneClient } from "./client.ts";
import {
	deriveRepoName,
	embedToken,
	parseGitUrl,
	redactUrl,
	toHttpsUrl,
	type GitContext,
	type ParsedGitUrl,
} from "./git.ts";
import type { GitAuthType, GitRepository } from "./types.ts";

/** Environment variables checked for a git token, in order. */
const TOKEN_ENV_VARS = [
	"ARCANE_GIT_TOKEN",
	"GIT_TOKEN",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"GITLAB_TOKEN",
	"CI_JOB_TOKEN",
];

export interface ResolvedRepo {
	/** Clean HTTPS URL, without credentials — what gets stored in Arcane. */
	url: string;
	/** Same URL with credentials inlined, for BuildKit git contexts. */
	authenticatedUrl: string;
	/** Safe to show to the user or the model. */
	displayUrl: string;
	authType: GitAuthType;
	token?: string;
	username?: string;
	parsed: ParsedGitUrl;
	/** Where the token came from, for reporting. */
	tokenSource?: string;
}

export class RepoResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RepoResolutionError";
	}
}

function tokenFromEnv(): { token: string; source: string } | undefined {
	for (const name of TOKEN_ENV_VARS) {
		const value = process.env[name];
		if (value) return { token: value, source: `$${name}` };
	}
	return undefined;
}

/**
 * Work out the URL and credentials Arcane should use.
 *
 * `explicitUrl` (the tool's `git_url`) wins over the local remote. A URL that
 * already carries credentials is taken at face value.
 */
export async function resolveRepo(
	ctx: ExtensionContext,
	git: GitContext | undefined,
	explicitUrl?: string,
	explicitToken?: string,
): Promise<ResolvedRepo> {
	const rawUrl = explicitUrl ?? git?.remoteUrl;
	if (!rawUrl) {
		throw new RepoResolutionError(
			"No git remote found. Add an 'origin' remote and push the branch, or pass git_url explicitly — Arcane clones the repository from its remote, not from the local working copy.",
		);
	}

	const parsed = parseGitUrl(rawUrl);
	if (!parsed) throw new RepoResolutionError(`Could not parse the git URL: ${rawUrl}`);

	// Already-credentialled HTTPS remotes are used exactly as given.
	if (parsed.kind === "https" && parsed.hasCredentials) {
		return {
			url: rawUrl,
			authenticatedUrl: rawUrl,
			displayUrl: redactUrl(rawUrl),
			authType: "token",
			parsed,
		};
	}

	const cleanUrl = toHttpsUrl(parsed);

	let token = explicitToken;
	let tokenSource = explicitToken ? "tool argument" : undefined;
	if (!token) {
		const found = tokenFromEnv();
		if (found) {
			token = found.token;
			tokenSource = found.source;
		}
	}

	if (!token && ctx.hasUI) {
		const reason =
			parsed.kind === "ssh"
				? `The remote is an SSH URL (${rawUrl}). Arcane needs HTTPS with a token to clone it.`
				: `Arcane needs a token to clone ${cleanUrl}.`;
		ctx.ui.notify(reason, "info");
		const entered = await ctx.ui.input(
			`Access token for ${parsed.host} (leave empty for a public repo):`,
		);
		if (entered && entered.trim()) {
			token = entered.trim();
			tokenSource = "entered interactively";
		}
	}

	if (!token) {
		// A public repository clones fine with no credentials at all.
		return {
			url: cleanUrl,
			authenticatedUrl: cleanUrl,
			displayUrl: cleanUrl,
			authType: "none",
			parsed,
		};
	}

	const username = parsed.host.includes("gitlab") ? undefined : "oauth2";

	return {
		url: cleanUrl,
		authenticatedUrl: embedToken(parsed, token, username),
		displayUrl: cleanUrl,
		authType: "token",
		token,
		username,
		parsed,
		tokenSource,
	};
}

/** Compare two git URLs ignoring scheme, credentials, `.git` and trailing slash. */
export function sameRepo(a: string, b: string): boolean {
	const left = parseGitUrl(a);
	const right = parseGitUrl(b);
	if (!left || !right) return a.trim() === b.trim();
	return (
		left.host.toLowerCase() === right.host.toLowerCase() &&
		left.path.toLowerCase() === right.path.toLowerCase()
	);
}

export interface RegisterRepoResult {
	repository: GitRepository;
	created: boolean;
	/** True when an existing record's credentials were refreshed. */
	updated: boolean;
}

/**
 * Find or create the Arcane git-repository record for `resolved`
 * (plan 3.1 step 4). An existing record for the same remote is reused, and its
 * credentials refreshed when a token is available.
 */
export async function registerRepository(
	client: ArcaneClient,
	resolved: ResolvedRepo,
	preferredName?: string,
	signal?: AbortSignal,
): Promise<RegisterRepoResult> {
	const existing = (await client.listRepositories(signal)).find((repo) =>
		sameRepo(repo.url, resolved.url),
	);

	if (existing) {
		// Refresh auth so a rotated token does not break the next sync.
		if (resolved.token) {
			const updated = await client.updateRepository(
				existing.id,
				{
					url: resolved.url,
					authType: resolved.authType,
					token: resolved.token,
					username: resolved.username,
					enabled: true,
				},
				signal,
			);
			return { repository: updated, created: false, updated: true };
		}
		return { repository: existing, created: false, updated: false };
	}

	const name = preferredName ?? deriveRepoName(resolved.parsed);
	const repository = await client.createRepository(
		{
			name,
			url: resolved.url,
			authType: resolved.authType,
			token: resolved.token,
			username: resolved.username,
			description: "Registered by the pi-arcane extension",
			enabled: true,
		},
		signal,
	);

	return { repository, created: true, updated: false };
}

/**
 * BuildKit git context reference: `<url>#<ref>:<subdir>`.
 * Credentials stay inline because BuildKit clones it directly.
 */
export function buildKitContext(
	resolved: ResolvedRepo,
	ref?: string,
	subdir?: string,
): string {
	let context = resolved.authenticatedUrl;
	if (ref) context += `#${ref}`;
	if (subdir && subdir !== ".") context += `${ref ? "" : "#"}:${subdir}`;
	return context;
}
