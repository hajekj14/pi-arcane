/**
 * Load the extension against a stub ExtensionAPI and report what it registers.
 *
 * This exercises real module loading, imports and registration without needing
 * a model or a live Arcane. Run with:
 *   node --experimental-strip-types scripts/smoke.ts
 */

import assert from "node:assert/strict";
import arcaneExtension from "../extension/index.ts";
import { generateCompose, prepareCompose, readComposeInfo } from "../extension/compose.ts";
import { embedToken, parseGitUrl, redactUrl, sanitizeName } from "../extension/git.ts";
import { parsePortMapping, resolveSecret, normalizeHost } from "../extension/config.ts";
import { publicUrlForContainer, routableContainerName } from "../extension/runtime.ts";
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
assert.deepEqual(commands.map((c) => c.name).sort(), ["arcane-setup", "arcane-status"]);
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

// The port is already right, but the container name still has to be pinned or
// Compose would generate "compose-app-web-1", which the vhost cannot route.
const alreadyMapped = prepareCompose(fixture, { routableName: "t-composeapp" });
assert.deepEqual(alreadyMapped.effectivePort, { host: "5553", container: "80" });
assert.equal(alreadyMapped.changed, true, "container_name is pinned even when ports are fine");
assert.equal(alreadyMapped.containerName, "t-composeapp");
assert.equal(
	readComposeInfo(alreadyMapped.content).primaryService?.containerName,
	"t-composeapp",
);
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

const ownName = prepareCompose(
	'services:\n  web:\n    image: nginx\n    container_name: my-own\n    ports:\n      - "5553:80"\n',
	{ routableName: "t-something" },
);
assert.equal(ownName.changed, false, "a compose file that names its own container is untouched");
assert.equal(ownName.containerName, "my-own");

const longSyntax = readComposeInfo(
	"services:\n  web:\n    image: nginx\n    ports:\n      - target: 80\n        published: '5553'\n",
);
assert.deepEqual(longSyntax.primaryService?.publishedPorts, [{ host: "5553", container: "80" }]);

const generated = generateCompose({
	serviceName: "web",
	image: "app:main",
	containerName: "t-app",
});
const generatedInfo = readComposeInfo(generated);
assert.equal(generatedInfo.primaryService?.image, "app:main");
assert.equal(generatedInfo.primaryService?.containerName, "t-app");
assert.deepEqual(generatedInfo.primaryService?.publishedPorts, [{ host: "5553", container: "80" }]);

// --- public URLs -----------------------------------------------------------
// The host vhost matches `t-[a-z0-9]+` and proxies to that exact container
// name, so anything with a dash after the prefix is genuinely unreachable and
// must report no URL rather than a plausible-looking one.
assert.equal(publicUrlForContainer("/t-myapp"), "https://t-myapp.hajek.click");
assert.equal(publicUrlForContainer("t-composeapp"), "https://t-composeapp.hajek.click");
assert.equal(publicUrlForContainer("compose-app-web-1"), undefined);
assert.equal(publicUrlForContainer("t-compose-app-web-1"), undefined);
assert.equal(publicUrlForContainer("t-App"), undefined);

assert.equal(routableContainerName("compose-app"), "t-composeapp");
assert.equal(routableContainerName("dockerfile-app"), "t-dockerfileapp");
assert.equal(routableContainerName("My_App.v2"), "t-myappv2");

console.log(`OK — ${tools.length} tools, ${commands.length} commands, ${renderers.length} renderers`);
console.log(`  tools:    ${toolNames.join(", ")}`);
console.log(`  commands: ${commands.map((c) => `/${c.name}`).join(", ")}`);
