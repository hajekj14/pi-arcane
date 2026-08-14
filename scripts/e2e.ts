/**
 * End-to-end test against the real Arcane (plan phases 8.3, 8.4, 10, 11).
 *
 * Drives the actual `arcane_*` tools — the same code path the model uses —
 * against both fixtures, then verifies over HTTP that the deployed page really
 * serves what is on disk.
 *
 * The decisive check is the uncommitted one: each fixture gets an untracked
 * marker file that exists nowhere in git, and the deployed site must serve it.
 * That is what proves the deploy came from the working tree rather than a clone.
 *
 * Credentials come from the same place the extension reads them: ARCANE_API_KEY,
 * or an `arcane.json` found by the normal resolution order. The config must also
 * carry `upload.url`, since deploys push the tree through the upload sidecar.
 *
 * Run with:
 *   node --experimental-strip-types scripts/e2e.ts [compose|dockerfile]
 */

import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDeployTool } from "../extension/tools/deploy.ts";
import { createLogsTool } from "../extension/tools/logs.ts";
import { createStatusTool } from "../extension/tools/status.ts";
import { createListTool } from "../extension/tools/list.ts";
import { resetRuntime } from "../extension/runtime.ts";
import { configSearchPaths, loadConfig } from "../extension/config.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Resolve credentials exactly the way the extension does, so a config file
// works as well as the environment variable.
const preflight = await loadConfig(repoRoot).catch((error: Error) => {
	console.error(`Arcane config is present but unusable: ${error.message}`);
	process.exit(2);
});

if (!preflight) {
	console.error(
		[
			"No Arcane credentials found. Either export ARCANE_API_KEY, or create one of:",
			...configSearchPaths(repoRoot).map((p) => `  ${p}`),
			'containing: { "apiKey": "your-key" }',
		].join("\n"),
	);
	process.exit(2);
}

console.log(
	`Auth:   ${preflight.sourcePath ? `arcane.json (${preflight.sourcePath})` : "ARCANE_API_KEY"}`,
);

if (!preflight.upload) {
	console.error(
		[
			"No upload sidecar configured, and every deploy uploads the working tree.",
			`Add to ${preflight.sourcePath ?? configSearchPaths(repoRoot)[0]}:`,
			'  "upload": { "url": "https://pump.example.com" }',
		].join("\n"),
	);
	process.exit(2);
}
console.log(`Upload: ${preflight.upload.url} -> ${preflight.upload.containerPath}`);

// --- stub extension host ----------------------------------------------------

const appended: Array<{ type: string; data: unknown }> = [];
const pi: any = {
	appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	registerTool: () => {},
	registerCommand: () => {},
	registerEntryRenderer: () => {},
	on: () => {},
};

function makeCtx(cwd: string): any {
	return {
		cwd,
		// Non-interactive: no prompts, so credentials must come from the
		// environment and environmentId from config or a single environment.
		hasUI: false,
		mode: "print",
		signal: undefined,
		ui: {
			notify: (message: string, level = "info") => console.log(`    [${level}] ${message}`),
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
		},
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		isIdle: () => true,
		isProjectTrusted: () => true,
	};
}

async function runTool(
	tool: any,
	params: unknown,
	cwd: string,
): Promise<{ text: string; details: any }> {
	const result = await tool.execute(
		"e2e",
		params,
		undefined,
		(update: any) => {
			const text = update?.content?.[0]?.text;
			if (text) {
				const lastLine = String(text).split("\n").pop();
				if (lastLine) console.log(`    · ${lastLine}`);
			}
		},
		makeCtx(cwd),
	);
	return {
		text: result.content.map((c: any) => c.text ?? "").join("\n"),
		details: result.details,
	};
}

// --- helpers ----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Poll a URL until it serves `expect`, or give up. */
async function waitForContent(
	url: string,
	expect: string,
	timeoutMs = 120_000,
): Promise<{ ok: boolean; status?: number; body?: string; error?: string }> {
	const deadline = Date.now() + timeoutMs;
	let last: { status?: number; body?: string; error?: string } = {};

	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, {
				redirect: "follow",
				signal: AbortSignal.timeout(10_000),
			});
			const body = await response.text();
			last = { status: response.status, body };
			if (response.ok && body.includes(expect)) return { ok: true, status: response.status, body };
		} catch (error) {
			last = { error: (error as Error).message };
		}
		await sleep(5000);
	}
	return { ok: false, ...last };
}

async function git(args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd: repoRoot });
	return stdout.trim();
}

// --- fixtures ---------------------------------------------------------------

interface Fixture {
	key: string;
	dir: string;
	projectName: string;
	htmlPath: string;
	marker: string;
}

const FIXTURES: Fixture[] = [
	{
		key: "compose",
		dir: join(repoRoot, "test-fixtures", "compose-app"),
		projectName: "compose-app",
		htmlPath: join(repoRoot, "test-fixtures", "compose-app", "www", "index.html"),
		marker: "Compose Deploy Works!",
	},
	{
		key: "dockerfile",
		dir: join(repoRoot, "test-fixtures", "dockerfile-app"),
		projectName: "dockerfile-app",
		htmlPath: join(repoRoot, "test-fixtures", "dockerfile-app", "www", "index.html"),
		marker: "Dockerfile Deploy Works!",
	},
];

const only = process.argv[2];
const selected = only ? FIXTURES.filter((f) => f.key === only) : FIXTURES;
if (selected.length === 0) {
	console.error(`Unknown fixture "${only}". Use one of: ${FIXTURES.map((f) => f.key).join(", ")}`);
	process.exit(2);
}

// --- run --------------------------------------------------------------------

const deployTool = createDeployTool(pi);
const statusTool = createStatusTool();
const logsTool = createLogsTool();
const listTool = createListTool();

const results: Array<{ fixture: string; step: string; ok: boolean; detail?: string }> = [];
function record(fixture: string, step: string, ok: boolean, detail?: string) {
	results.push({ fixture, step, ok, detail });
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${step}${detail && !ok ? ` — ${detail}` : ""}`);
}

const branch = await git(["branch", "--show-current"]);
console.log(`Repo:   ${repoRoot}`);
console.log(`Branch: ${branch}`);
console.log(`Arcane: ${process.env.ARCANE_HOST ?? "https://arcane.hajek.click"}\n`);

// Sanity: the environment must be reachable before anything else is meaningful.
try {
	const listed = (await runTool(listTool, { resource: "environments" }, repoRoot)).text;
	console.log(listed.split("\n").slice(0, 4).join("\n"));
	console.log();
} catch (error) {
	console.error(`Cannot reach Arcane: ${(error as Error).message}`);
	process.exit(1);
}

for (const fixture of selected) {
	console.log(`\n=== ${fixture.key} (${fixture.projectName}) ===`);
	resetRuntime();

	// 0. Plant an uncommitted marker ------------------------------------------
	// Untracked and never committed, so serving it can only mean the deploy came
	// from the working tree. Removed again in the finally below, whatever happens.
	const stamp = new Date().toISOString();
	const markerName = "uncommitted-marker.html";
	const markerFile = join(fixture.dir, "www", markerName);
	const markerText = `working tree ${stamp}`;
	await writeFile(markerFile, `<!DOCTYPE html>\n<html><body><h1>${markerText}</h1></body></html>\n`, "utf8");

	try {
		// 1. Deploy -------------------------------------------------------------
		let deployOutput = "";
		let deployDetails: any;
		try {
			const deployed = await runTool(deployTool, { project_name: fixture.projectName }, fixture.dir);
			deployOutput = deployed.text;
			deployDetails = deployed.details;
			record(fixture.key, "arcane_deploy", true);
		} catch (error) {
			record(fixture.key, "arcane_deploy", false, (error as Error).message);
			console.log((error as Error).message);
			continue;
		}
		console.log(indent(deployOutput));

		// 2. Verify over HTTP ---------------------------------------------------
		const endpoints: any[] = deployDetails?.endpoints ?? [];
		const url: string | undefined = endpoints.flatMap((e: any) => e.urls ?? [])[0];
		if (!url) {
			record(
				fixture.key,
				"deploy reported a public URL",
				false,
				"no container published a host port",
			);
			continue;
		}
		const expected = await readFile(fixture.htmlPath, "utf8");
		const marker = extractMarker(expected) ?? fixture.marker;

		console.log(`  probing ${url} for ${JSON.stringify(marker)} ...`);
		const probe = await waitForContent(url, marker);
		record(
			fixture.key,
			`serves the fixture page at ${url}`,
			probe.ok,
			probe.error ?? `HTTP ${probe.status}, body did not contain the marker`,
		);
		if (!probe.ok && probe.body) console.log(indent(probe.body.slice(0, 300)));

		// 3. The uncommitted file must be live ----------------------------------
		const markerUrl = `${url}/${markerName}`;
		console.log(`  probing ${markerUrl} for the uncommitted marker ...`);
		const markerProbe = await waitForContent(markerUrl, markerText, 60_000);
		record(
			fixture.key,
			"serves an uncommitted, untracked file (working tree, not git)",
			markerProbe.ok,
			markerProbe.error ?? `HTTP ${markerProbe.status}`,
		);

		// 4. A second deploy must re-upload almost nothing -----------------------
		try {
			const again = await runTool(deployTool, { project_name: fixture.projectName }, fixture.dir);
			const upload = again.details?.upload;
			record(
				fixture.key,
				`redeploy is incremental (${upload?.uploaded ?? "?"} sent, ${upload?.unchanged ?? "?"} unchanged)`,
				upload !== undefined && upload.uploaded === 0 && upload.unchanged > 0,
				JSON.stringify(upload),
			);
		} catch (error) {
			record(fixture.key, "incremental redeploy", false, (error as Error).message);
		}

		// 5. Status --------------------------------------------------------------
		try {
			const status = (await runTool(statusTool, { project_name: fixture.projectName }, fixture.dir))
				.text;
			const running = /status=running/i.test(status) || /● /.test(status);
			record(fixture.key, "arcane_status reports the project", running, status.slice(0, 300));
			console.log(indent(status));
		} catch (error) {
			record(fixture.key, "arcane_status", false, (error as Error).message);
		}

		// 6. Logs ------------------------------------------------------------------
		try {
			const logs = (
				await runTool(logsTool, { project_name: fixture.projectName, tail: 50 }, fixture.dir)
			).text;
			record(fixture.key, "arcane_logs returns output", logs.length > 0, logs.slice(0, 200));
			console.log(indent(logs.split("\n").slice(0, 12).join("\n")));
		} catch (error) {
			record(fixture.key, "arcane_logs", false, (error as Error).message);
		}
	} finally {
		// Never leave the marker behind: it would show up as a dirty working tree
		// and get uploaded by every later deploy.
		await rm(markerFile, { force: true });
	}
}

// --- summary ----------------------------------------------------------------

console.log("\n=== summary ===");
for (const result of results) {
	console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.fixture}: ${result.step}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);

// --- utils ------------------------------------------------------------------

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
}

/** Pull the <h1> text out of the fixture page, so the check follows edits. */
function extractMarker(html: string): string | undefined {
	return /<h1>([^<]+)<\/h1>/i.exec(html)?.[1]?.trim();
}
