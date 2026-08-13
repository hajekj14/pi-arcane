/**
 * Local git inspection and remote-URL normalisation (plan phase 6.1).
 *
 * Arcane clones the repository itself, so the URL handed to it must be
 * reachable and carry credentials. These helpers read the local checkout and
 * convert whatever remote it has into something Arcane can use.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GitError";
	}
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			signal,
			timeout: 30_000,
			maxBuffer: 4 * 1024 * 1024,
			env: {
				...process.env,
				// Never block on an interactive credential prompt. A hidden prompt
				// on a network operation such as ls-remote would hang the deploy
				// with no visible cause; failing fast turns it into a warning.
				GIT_TERMINAL_PROMPT: "0",
				GIT_ASKPASS: "",
				SSH_ASKPASS: "",
				GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new",
			},
		});
		return stdout.trim();
	} catch (error) {
		const err = error as NodeJS.ErrnoException & { stderr?: string };
		if (err.code === "ENOENT") throw new GitError("git is not installed or not on PATH");
		throw new GitError(
			`git ${args.join(" ")} failed: ${(err.stderr ?? err.message ?? "").trim() || "unknown error"}`,
		);
	}
}

/** Absolute path of the repository root containing `cwd`. */
export async function getRepoRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		return await git(cwd, ["rev-parse", "--show-toplevel"], signal);
	} catch {
		return undefined;
	}
}

export async function getRemoteUrl(
	cwd: string,
	remote = "origin",
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const url = await git(cwd, ["config", "--get", `remote.${remote}.url`], signal);
		return url || undefined;
	} catch {
		return undefined;
	}
}

export async function getCurrentBranch(
	cwd: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const branch = await git(cwd, ["branch", "--show-current"], signal);
		return branch || undefined;
	} catch {
		return undefined;
	}
}

export async function getHeadCommit(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		return await git(cwd, ["rev-parse", "HEAD"], signal);
	} catch {
		return undefined;
	}
}

/** True when the working tree has uncommitted changes. */
export async function isDirty(cwd: string, signal?: AbortSignal): Promise<boolean> {
	try {
		const status = await git(cwd, ["status", "--porcelain"], signal);
		return status.length > 0;
	} catch {
		return false;
	}
}

/**
 * Whether the remote has the branch.
 *
 * `unknown` is deliberately distinct from `absent`: `git ls-remote` fails for
 * auth and network reasons too (no SSH agent, no token, offline), and treating
 * that as "not pushed" would tell people to push work they already pushed.
 * Only a successful query that lists nothing means the branch is really gone.
 */
export type RemoteBranchState = "present" | "absent" | "unknown";

export interface RemoteBranchStatus {
	state: RemoteBranchState;
	/** Commit the remote has for the branch, when it could be read. */
	remoteCommit?: string;
	/** Local commit for the branch. */
	localCommit?: string;
	/** True only when both commits are known and equal. */
	upToDate?: boolean;
	/** Why the query failed, when `state` is `"unknown"`. */
	error?: string;
}

/**
 * Query the remote for `branch` and compare it with the local tip.
 *
 * One `ls-remote` gives both existence and the remote SHA, so this replaces a
 * separate "exists" and "is pushed" pair of network calls.
 */
export async function checkRemoteBranch(
	cwd: string,
	branch: string,
	remote = "origin",
	signal?: AbortSignal,
): Promise<RemoteBranchStatus> {
	const localCommit = await git(cwd, ["rev-parse", branch], signal).catch(() => undefined);

	let listing: string;
	try {
		listing = await git(cwd, ["ls-remote", "--heads", remote, branch], signal);
	} catch (error) {
		return { state: "unknown", localCommit, error: (error as Error).message };
	}

	if (listing.trim().length === 0) return { state: "absent", localCommit };

	const remoteCommit = listing.split(/\s+/)[0];
	return {
		state: "present",
		remoteCommit,
		localCommit,
		upToDate: Boolean(localCommit) && localCommit === remoteCommit,
	};
}

export interface ParsedGitUrl {
	/** `https` for HTTP(S) remotes, `ssh` for scp-style or ssh:// remotes. */
	kind: "https" | "ssh";
	host: string;
	/** `owner/repo`, without a trailing `.git`. */
	path: string;
	/** True when the URL already carries a username/password or token. */
	hasCredentials: boolean;
	/** The URL as given. */
	original: string;
}

/** Parse both `https://host/owner/repo.git` and `git@host:owner/repo.git`. */
export function parseGitUrl(url: string): ParsedGitUrl | undefined {
	const trimmed = url.trim();
	if (!trimmed) return undefined;

	// scp-style: [user@]host:path
	const scp = /^(?:([^@/]+)@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
	if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
		return {
			kind: "ssh",
			host: scp[2],
			path: stripGitSuffix(scp[3]),
			hasCredentials: false,
			original: trimmed,
		};
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return undefined;
	}

	const path = stripGitSuffix(parsed.pathname.replace(/^\/+/, ""));
	if (parsed.protocol === "ssh:") {
		return { kind: "ssh", host: parsed.hostname, path, hasCredentials: false, original: trimmed };
	}
	if (parsed.protocol === "http:" || parsed.protocol === "https:") {
		return {
			kind: "https",
			host: parsed.hostname,
			path,
			hasCredentials: Boolean(parsed.username || parsed.password),
			original: trimmed,
		};
	}
	return undefined;
}

function stripGitSuffix(path: string): string {
	return path.replace(/\.git$/i, "").replace(/\/+$/, "");
}

/** `https://host/owner/repo.git`, with any embedded credentials removed. */
export function toHttpsUrl(parsed: ParsedGitUrl): string {
	return `https://${parsed.host}/${parsed.path}.git`;
}

/**
 * Embed a token so Arcane can clone over HTTPS.
 *
 * GitLab wants `https://TOKEN:@host/...`; GitHub wants a username, and
 * `oauth2` works for both classic and fine-grained tokens.
 */
export function embedToken(parsed: ParsedGitUrl, token: string, username?: string): string {
	const user = username ?? (parsed.host.includes("gitlab") ? token : "oauth2");
	const pass = username ? token : parsed.host.includes("gitlab") ? "" : token;
	return `https://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${parsed.host}/${parsed.path}.git`;
}

/** Hide credentials before a URL is shown to the user or the model. */
export function redactUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.username || parsed.password) {
			parsed.username = parsed.username ? "***" : "";
			parsed.password = parsed.password ? "***" : "";
		}
		return parsed.toString();
	} catch {
		return url.replace(/\/\/[^@/]+@/, "//***@");
	}
}

/** Last path segment of the repo, lowercased and safe for use as a name. */
export function deriveRepoName(parsed: ParsedGitUrl): string {
	const last = parsed.path.split("/").filter(Boolean).pop() ?? "app";
	return sanitizeName(last);
}

/**
 * Normalise to a Docker/Arcane-safe name: lowercase, alphanumerics and dashes,
 * no leading or trailing separator.
 */
export function sanitizeName(value: string): string {
	const cleaned = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-._]+/, "")
		.replace(/[-._]+$/, "");
	return cleaned || "app";
}

export interface GitContext {
	repoRoot: string;
	remoteUrl?: string;
	parsedRemote?: ParsedGitUrl;
	branch?: string;
	commit?: string;
	dirty: boolean;
}

/** Collect everything the deploy tool needs from the local checkout. */
export async function readGitContext(
	cwd: string,
	signal?: AbortSignal,
): Promise<GitContext | undefined> {
	const repoRoot = await getRepoRoot(cwd, signal);
	if (!repoRoot) return undefined;

	const [remoteUrl, branch, commit, dirty] = await Promise.all([
		getRemoteUrl(repoRoot, "origin", signal),
		getCurrentBranch(repoRoot, signal),
		getHeadCommit(repoRoot, signal),
		isDirty(repoRoot, signal),
	]);

	return {
		repoRoot,
		remoteUrl,
		parsedRemote: remoteUrl ? parseGitUrl(remoteUrl) : undefined,
		branch,
		commit,
		dirty,
	};
}
