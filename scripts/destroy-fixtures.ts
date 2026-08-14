/**
 * Tear down the E2E fixture deployments using the real arcane_destroy tool.
 *
 * Run with: node --experimental-strip-types scripts/destroy-fixtures.ts [project...]
 * Defaults to the two test fixtures.
 */

import { createDestroyTool } from "../extension/tools/destroy.ts";
import { createListTool } from "../extension/tools/list.ts";
import { resetRuntime } from "../extension/runtime.ts";

function makeCtx(cwd: string): any {
	return {
		cwd,
		// No UI, so arcane_destroy skips its confirmation prompt — this script is
		// the explicit confirmation.
		hasUI: false,
		mode: "print",
		signal: undefined,
		ui: {
			notify: (m: string, l = "info") => console.log(`    [${l}] ${m}`),
			select: async () => undefined,
			confirm: async () => true,
			input: async () => undefined,
		},
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		isIdle: () => true,
		isProjectTrusted: () => true,
	};
}

async function runTool(tool: any, params: unknown, cwd: string): Promise<string> {
	const result = await tool.execute(
		"destroy",
		params,
		undefined,
		(update: any) => {
			const text = update?.content?.[0]?.text;
			if (text) {
				const last = String(text).split("\n").pop();
				if (last) console.log(`    · ${last}`);
			}
		},
		makeCtx(cwd),
	);
	return result.content.map((c: any) => c.text ?? "").join("\n");
}

const cwd = process.cwd();
const targets = process.argv.slice(2);
const projects = targets.length > 0 ? targets : ["compose-app", "dockerfile-app"];

const destroyTool = createDestroyTool();
const listTool = createListTool();

let failed = 0;
for (const name of projects) {
	console.log(`\n=== destroying ${name} ===`);
	resetRuntime();
	try {
		const out = await runTool(destroyTool, { project_name: name, remove_volumes: true }, cwd);
		console.log(out.split("\n").map((l) => `    ${l}`).join("\n"));
	} catch (error) {
		failed += 1;
		console.log(`    FAILED: ${(error as Error).message}`);
	}
}

console.log("\n=== remaining projects ===");
resetRuntime();
console.log(await runTool(listTool, { resource: "projects" }, cwd));

console.log("\n=== remaining uploaded build contexts ===");
resetRuntime();
console.log(await runTool(listTool, { resource: "contexts" }, cwd));

process.exit(failed === 0 ? 0 : 1);
