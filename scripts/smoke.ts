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
import {
	generateCompose,
	prepareCompose,
	readComposeInfo,
	rewriteBuildContexts,
} from "../extension/compose.ts";
import { sanitizeName } from "../extension/git.ts";
import { parsePortMapping, resolveSecret, normalizeHost } from "../extension/config.ts";
import { publicUrlForPort, publicUrlsForContainer } from "../extension/runtime.ts";
import { collectFiles, contextSlug, formatBytes } from "../extension/upload.ts";

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

// --- naming ----------------------------------------------------------------
assert.equal(sanitizeName("Feature/My_Branch"), "feature-my_branch");

// --- upload: slug ----------------------------------------------------------
// Two checkouts of the same project must not share a context directory, or one
// deploy would overwrite the other's build inputs.
{
	const a = contextSlug("/home/me/work/app", "app");
	const b = contextSlug("/home/me/other/app", "app");
	assert.notEqual(a, b, "different checkouts get different slugs");
	assert.equal(a, contextSlug("/home/me/work/app", "app"), "the slug is stable");
	assert.ok(a.startsWith("app-"), "the slug is recognisable");
	assert.match(a, /^[a-z0-9._-]+$/, "the slug is safe as a path segment");
}

assert.equal(formatBytes(512), "512 B");
assert.equal(formatBytes(2 * 1024 * 1024), "2.0 MB");

// --- upload: file selection -------------------------------------------------
// Uses this repo, which has a .gitignore excluding node_modules and .pi/.
{
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const files = await collectFiles(repoRoot);
	const paths = files.map((f) => f.path);

	assert.ok(paths.includes("package.json"), "tracked files are collected");
	assert.ok(paths.includes("extension/upload.ts"), "nested files keep POSIX paths");
	assert.ok(
		!paths.some((p) => p.startsWith("node_modules/")),
		"gitignored directories are excluded",
	);
	assert.ok(!paths.some((p) => p.includes("\\")), "no backslashes leak into upload paths");
	assert.ok(
		files.every((f) => f.size >= 0 && f.absolutePath.length > 0),
		"every file carries a size and an absolute path",
	);
}

// --- upload: compose build contexts ----------------------------------------
// A compose build context is relative to the compose file and means nothing on
// the Arcane host, so it must be repointed at the uploaded copy.
{
	const rewritten = rewriteBuildContexts(
		"services:\n  web:\n    build: .\n  api:\n    build:\n      context: ./api\n      dockerfile: Dockerfile.api\n  db:\n    image: postgres\n",
		"/app/data/pi-arcane/app-abc123/ctx",
	);
	assert.deepEqual(rewritten.rewritten, ["web", "api"], "only services with build: are touched");

	const doc = rewritten.content;
	assert.ok(doc.includes("/app/data/pi-arcane/app-abc123/ctx"), "web points at the upload");
	assert.ok(doc.includes("/app/data/pi-arcane/app-abc123/ctx/api"), "api keeps its subdirectory");
	assert.ok(doc.includes("Dockerfile.api"), "other build keys survive the rewrite");
	assert.ok(doc.includes("postgres"), "image-only services are untouched");

	const absolute = rewriteBuildContexts(
		"services:\n  web:\n    build:\n      context: /srv/thing\n",
		"/app/data/pi-arcane/app-abc123/ctx",
	);
	assert.deepEqual(absolute.rewritten, [], "an absolute context is left alone");

	const nested = rewriteBuildContexts(
		"services:\n  web:\n    build: .\n",
		"/app/data/pi-arcane/app-abc123/ctx",
		"deploy",
	);
	assert.ok(
		nested.content.includes("/app/data/pi-arcane/app-abc123/ctx/deploy"),
		"a compose file in a subdirectory resolves against its own directory",
	);
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
