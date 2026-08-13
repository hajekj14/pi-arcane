/**
 * `/arcane-destroy` — interactive teardown (plan phase 7.1).
 *
 * Thin wrapper over the `arcane_destroy` tool so the same logic backs both the
 * command and the LLM-callable tool. With no argument it lists the projects and
 * asks which to remove.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { requireRuntime } from "../runtime.ts";
import { createDestroyTool } from "../tools/destroy.ts";

export async function runDestroy(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/arcane-destroy needs an interactive UI.", "error");
		return;
	}

	let projectName = args.trim();

	try {
		if (!projectName) {
			const { client, environmentId } = await requireRuntime(ctx);
			const projects = await client.listProjects(environmentId);
			if (projects.length === 0) {
				ctx.ui.notify("No projects to destroy in this environment.", "info");
				return;
			}
			const labels = projects.map(
				(p) => `${p.name}  (${p.status}, ${p.runningCount}/${p.serviceCount} services)`,
			);
			const picked = await ctx.ui.select("Destroy which project?", labels);
			if (!picked) return;
			projectName = projects[labels.indexOf(picked)].name;
		}

		const removeVolumes = await ctx.ui.confirm(
			"Delete volumes too?",
			`Also delete "${projectName}"'s named volumes and all their data? This cannot be undone.\nChoose No to keep the data.`,
		);

		// The tool runs its own confirmation, so this stays a single prompt chain.
		const tool = createDestroyTool();
		const result = await tool.execute(
			"arcane-destroy-command",
			{ project_name: projectName, remove_volumes: removeVolumes },
			undefined,
			undefined,
			ctx,
		);

		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
		ctx.ui.notify(text.split("\n")[0] ?? `Destroyed ${projectName}.`, "info");
	} catch (error) {
		ctx.ui.notify(`Destroy failed: ${(error as Error).message}`, "error");
	}
}
