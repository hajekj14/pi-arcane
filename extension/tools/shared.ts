/**
 * Helpers shared by the Arcane tools.
 */

import { ArcaneApiError } from "../client.ts";
import { ArcaneSetupError } from "../runtime.ts";
import { WebSocketError } from "../ws.ts";
import { ComposeError } from "../compose.ts";
import { GitError } from "../git.ts";

/**
 * Turn an internal error into one whose message is useful to the model.
 *
 * Tools signal failure by throwing (pi sets `isError` on the result), so the
 * message is all the model gets — it has to say what broke and what to try.
 */
export function toolError(error: unknown): Error {
	if (error instanceof ArcaneSetupError) return error;

	if (error instanceof ArcaneApiError) {
		// 401 and 403 mean different things and have different fixes: a bad key
		// versus a valid key that was not granted a scope. Conflating them sends
		// people to re-check credentials that are perfectly fine.
		if (error.status === 401) {
			return new Error(
				`${error.message}\nThe Arcane API key was rejected. Verify apiKey in arcane.json / ARCANE_API_KEY, or run /arcane-setup.`,
			);
		}
		if (error.status === 403) {
			const scope = /permission denied:\s*([\w.:-]+)/i.exec(error.detail ?? "")?.[1];
			return new Error(
				`${error.message}\nThe API key authenticated but lacks ${
					scope ? `the "${scope}" permission` : "permission for this operation"
				}. Grant it to the key in Arcane (Settings → API Keys), or use a key with broader scope.`,
			);
		}
		if (error.isNotFound) {
			return new Error(`${error.message}\nThe resource does not exist (or the ID is stale).`);
		}
		return new Error(error.message);
	}

	if (error instanceof WebSocketError) {
		if (error.status === 401 || error.status === 403) {
			return new Error(
				`${error.message}\nArcane rejected the log stream credentials. Run /arcane-setup to re-check the API key.`,
			);
		}
		return new Error(error.message);
	}

	if (error instanceof GitError || error instanceof ComposeError) return error;

	if (error instanceof Error) return error;
	return new Error(String(error));
}

/** Truncate a block of text, noting how much was dropped. */
export function clampText(text: string, maxChars = 40_000): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} more characters]`;
}

/** Render `key=value` pairs, skipping empties, for compact tool output. */
export function fields(pairs: Array<[string, unknown]>): string {
	return pairs
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([key, value]) => `${key}=${String(value)}`)
		.join("  ");
}
