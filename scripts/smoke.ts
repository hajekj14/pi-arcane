/**
 * Load the extension against a stub ExtensionAPI and report what it registers.
 *
 * This exercises real module loading, imports and registration without needing
 * a model or a live Arcane. Run with:
 *   node --experimental-strip-types scripts/smoke.ts
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import arcaneExtension from "../extension/index.ts";
import { generateCompose, prepareCompose, readComposeInfo } from "../extension/compose.ts";
import {
	checkRemoteBranch,
	embedToken,
	parseGitUrl,
	redactUrl,
	sanitizeName,
} from "../extension/git.ts";
import { parsePortMapping, resolveSecret, normalizeHost } from "../extension/config.ts";
import { publicUrlForPort, publicUrlsForContainer } from "../extension/runtime.ts";
import { sameRepo, buildKitContext } from "../extension/repo.ts";

const tools: any[] = [];
const commands: Array<{ name: string; options: any }> = [];
const events: string[] = [];
const renderers: string[] = [];

const pi: any = {
	registerTool: (tool: any) => tools.push(tool),
	registerCommand: (name: string, options: any) => commands.push({ name, options }),
	registerEntryRenderer: (type: string) => renderers.push(type),
	on: (event: string) => events.push(event),
	appendEntry: () => {},
};

arcaneExtension(pi);

// --- registration ----------------------------------------------------------
const toolNames = tools.map((t) => t.name).sort();
assert.deepEqual(toolNames, [
	"arcane_build",
	"arcane_deploy",
	"arcane_destroy",
	"arcane_list",
	"arcane_logs",
	"arcane_status",
]);
for (const tool of tools) {
	assert.ok(tool.label, `${tool.name} has a label`);
	assert.ok(tool.description, `${tool.name} has a description`);
	assert.ok(tool.parameters, `${tool.name} has parameters`);
	assert.equal(typeof tool.execute, "function", `${tool.name} is executable`);
}
assert.deepEqual(commands.map((c) => c.name).sort(), [
	"arcane-destroy",
	"arcane-setup",
	"arcane-status",
]);
assert.deepEqual(events.sort(), ["session_shutdown", "session_start"]);
assert.deepEqual(renderers.sort(), ["arcane-deployment", "arcane-status"]);

// --- git URL handling ------------------------------------------------------
const ssh = parseGitUrl("git@github.com:hajekj14/pi-arcane.git");
assert.equal(ssh?.kind, "ssh");
assert.equal(ssh?.host, "github.com");
assert.equal(ssh?.path, "hajekj14/pi-arcane");

const https = parseGitUrl("https://github.com/hajekj14/pi-arcane.git");
assert.equal(https?.kind, "https");
assert.equal(https?.hasCredentials, false);

const withCreds = parseGitUrl("https://tok:@gitlab.com/g/p.git");
assert.equal(withCreds?.hasCredentials, true);

assert.equal(
	embedToken(https!, "SECRET", "oauth2"),
	"https://oauth2:SECRET@github.com/hajekj14/pi-arcane.git",
);
assert.ok(!redactUrl("https://oauth2:SECRET@github.com/a/b.git").includes("SECRET"));
assert.ok(sameRepo("git@github.com:a/b.git", "https://github.com/a/b"));
assert.ok(!sameRepo("git@github.com:a/b.git", "https://github.com/a/c"));
assert.equal(sanitizeName("Feature/My_Branch"), "feature-my_branch");

assert.equal(
	buildKitContext(
		{ authenticatedUrl: "https://github.com/a/b.git" } as any,
		"main",
		"test-fixtures/compose-app",
	),
	"https://github.com/a/b.git#main:test-fixtures/compose-app",
);
assert.equal(
	buildKitContext({ authenticatedUrl: "https://github.com/a/b.git" } as any, "main", "."),
	"https://github.com/a/b.git#main",
);

// --- remote branch state ---------------------------------------------------
// A remote that cannot be reached must report "unknown", never "absent" —
// otherwise an auth or network failure tells the user to push work that is
// already pushed. Using this repo as its own remote keeps the test offline.
{
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

	const present = await checkRemoteBranch(repoRoot, "main", repoRoot);
	assert.equal(present.state, "present");
	assert.equal(present.upToDate, true, "local main matches itself");
	assert.ok(present.remoteCommit);

	const absent = await checkRemoteBranch(repoRoot, "no-such-branch-xyz", repoRoot);
	assert.equal(absent.state, "absent", "a reachable remote without the branch is absent");

	const unreachable = await checkRemoteBranch(repoRoot, "main", "not-a-real-remote-xyz");
	assert.equal(unreachable.state, "unknown", "an unreachable remote is unknown, not absent");
	assert.ok(unreachable.error, "the failure reason is reported");
}

// --- config ----------------------------------------------------------------
assert.equal(normalizeHost("https://arcane.hajek.click/api/"), "https://arcane.hajek.click");
assert.deepEqual(parsePortMapping("8080:80"), { host: "8080", container: "80" });
assert.deepEqual(parsePortMapping("9000"), { host: "9000", container: "80" });
process.env.__ARCANE_SMOKE = "abc123";
assert.equal(await resolveSecret("$__ARCANE_SMOKE"), "abc123");
assert.equal(await resolveSecret("${__ARCANE_SMOKE}"), "abc123");
assert.equal(await resolveSecret("literal-key"), "literal-key");
await assert.rejects(() => resolveSecret("$__ARCANE_MISSING_VAR"));

// --- compose ---------------------------------------------------------------
const fixture = 'services:\n  web:\n    build: .\n    ports:\n      - "5553:80"\n';
const info = readComposeInfo(fixture);
assert.equal(info.primaryService?.name, "web");
assert.deepEqual(info.primaryService?.publishedPorts, [{ host: "5553", container: "80" }]);

const alreadyMapped = prepareCompose(fixture);
assert.deepEqual(alreadyMapped.effectivePort, { host: "5553", container: "80" });
assert.equal(alreadyMapped.changed, false, "an existing mapping is left untouched");
assert.deepEqual(
	readComposeInfo(alreadyMapped.content).primaryService?.publishedPorts,
	[{ host: "5553", container: "80" }],
	"the existing 5553 mapping is not duplicated",
);

const noPorts = prepareCompose("services:\n  web:\n    build: .\n");
assert.equal(noPorts.changed, true, "a service publishing nothing gets the default mapping");
assert.deepEqual(noPorts.effectivePort, { host: "5553", container: "80" });
assert.deepEqual(readComposeInfo(noPorts.content).primaryService?.publishedPorts, [
	{ host: "5553", container: "80" },
]);

const explicitOther = prepareCompose(
	'services:\n  web:\n    build: .\n    ports:\n      - "8080:80"\n',
);
assert.deepEqual(
	explicitOther.effectivePort,
	{ host: "8080", container: "80" },
	"explicit user ports are respected, not overridden",
);
assert.deepEqual(
	readComposeInfo(explicitOther.content).primaryService?.publishedPorts,
	[{ host: "8080", container: "80" }],
	"no second mapping is added alongside the user's",
);



const longSyntax = readComposeInfo(
	"services:\n  web:\n    image: nginx\n    ports:\n      - target: 80\n        published: '5553'\n",
);
assert.deepEqual(longSyntax.primaryService?.publishedPorts, [{ host: "5553", container: "80" }]);

const generated = generateCompose({ serviceName: "web", image: "app:main" });
const generatedInfo = readComposeInfo(generated);
assert.equal(generatedInfo.primaryService?.image, "app:main");
assert.deepEqual(generatedInfo.primaryService?.publishedPorts, [{ host: "5553", container: "80" }]);

// --- public URLs -----------------------------------------------------------
// Routing is port-encoded: pi-<hostPort>.hajek.click proxies to 127.0.0.1:<port>.
// Container names are irrelevant, which is why nothing is pinned in compose.
assert.equal(publicUrlForPort(5553), "https://pi-5553.hajek.click");
assert.equal(publicUrlForPort("8080"), "https://pi-8080.hajek.click");

assert.deepEqual(
	publicUrlsForContainer([{ publicPort: 5553 }, { publicPort: 5553 }, { publicPort: 8080 }]),
	["https://pi-5553.hajek.click", "https://pi-8080.hajek.click"],
	"duplicate host ports collapse to one URL each",
);
assert.deepEqual(publicUrlsForContainer([{}]), [], "an unpublished port yields no URL");
assert.deepEqual(publicUrlsForContainer(null), []);

console.log(`OK — ${tools.length} tools, ${commands.length} commands, ${renderers.length} renderers`);
console.log(`  tools:    ${toolNames.join(", ")}`);
console.log(`  commands: ${commands.map((c) => `/${c.name}`).join(", ")}`);
