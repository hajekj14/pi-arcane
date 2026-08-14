/**
 * Local git inspection.
 *
 * Deploys upload the working tree, so git is only ever a source of *context* —
 * where the project root is, which branch is checked out, whether there are
 * uncommitted edits. Nothing here talks to a remote, and a project that is not
 * a git repository at all still deploys fine.
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
				// Never block on a hidden credential prompt; a stalled deploy with no
				// visible cause is worse than a fast failure.
				GIT_TERMINAL_PROMPT: "0",
				GIT_ASKPASS: "",
				SSH_ASKPASS: "",
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

/** Counts of uncommitted changes, for reporting what the upload will include. */
export interface DirtyState {
	dirty: boolean;
	modified: number;
	untracked: number;
}

export async function readDirtyState(cwd: string, signal?: AbortSignal): Promise<DirtyState> {
	try {
		const status = await git(cwd, ["status", "--porcelain"], signal);
		const lines = status.split("\n").filter((line) => line.trim().length > 0);
		const untracked = lines.filter((line) => line.startsWith("??")).length;
		return { dirty: lines.length > 0, modified: lines.length - untracked, untracked };
	} catch {
		return { dirty: false, modified: 0, untracked: 0 };
	}
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
	branch?: string;
	commit?: string;
	dirty: DirtyState;
}

/** Collect what the deploy tools report about the local checkout. */
export async function readGitContext(
	cwd: string,
	signal?: AbortSignal,
): Promise<GitContext | undefined> {
	const repoRoot = await getRepoRoot(cwd, signal);
	if (!repoRoot) return undefined;

	const [branch, commit, dirty] = await Promise.all([
		getCurrentBranch(repoRoot, signal),
		getHeadCommit(repoRoot, signal),
		readDirtyState(repoRoot, signal),
	]);

	return { repoRoot, branch, commit, dirty };
}
