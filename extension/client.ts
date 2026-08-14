/**
 * Typed HTTP client for the Arcane REST API (plan phase 2).
 *
 * Every method unwraps Arcane's `{ success, data }` envelope and turns
 * non-2xx answers (RFC 7807 problem documents) into `ArcaneApiError`, so
 * callers only deal with payloads.
 */

import { collectWebSocketMessages } from "./ws.ts";
import {
	FAILED_ACTIVITY_STATUSES,
	TERMINAL_ACTIVITY_STATUSES,
	type Activity,
	type ActivityDetail,
	type BaseApiResponse,
	type BasePaginated,
	type BuildProjectRequest,
	type BuildRequest,
	type ContainerDetails,
	type ContainerListResponse,
	type ContainerSummary,
	type DashboardSnapshot,
	type CreateProjectRequest,
	type CreateProjectResponse,
	type DeployOptions,
	type DestroyOptions,
	type Environment,
	type ErrorModel,
	type ImageBuildRecord,
	type ImageSummary,
	type MessageResponse,
	type ProjectDetails,
	type UpdateProjectRequest,
	type VolumeFileEntry,
} from "./types.ts";

export class ArcaneApiError extends Error {
	readonly status: number;
	readonly method: string;
	readonly path: string;
	readonly detail?: string;
	readonly body?: string;

	constructor(init: {
		status: number;
		method: string;
		path: string;
		title?: string;
		detail?: string;
		body?: string;
	}) {
		const parts = [`Arcane ${init.method} ${init.path} failed with HTTP ${init.status}`];
		if (init.title) parts.push(init.title);
		if (init.detail && init.detail !== init.title) parts.push(init.detail);
		super(parts.join(": "));
		this.name = "ArcaneApiError";
		this.status = init.status;
		this.method = init.method;
		this.path = init.path;
		this.detail = init.detail;
		this.body = init.body;
	}

	/** True when the key is missing, invalid, or lacks permission. */
	get isAuthError(): boolean {
		return this.status === 401 || this.status === 403;
	}

	get isNotFound(): boolean {
		return this.status === 404;
	}
}

export interface RequestOptions {
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	signal?: AbortSignal;
	/** Read the response as text instead of unwrapping a JSON envelope. */
	raw?: boolean;
	timeoutMs?: number;
}

/** Options accepted by both log endpoints. */
export interface LogOptions {
	tail?: number;
	timestamps?: boolean;
	since?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface WaitForActivityOptions {
	signal?: AbortSignal;
	/** Overall budget before giving up on a still-running activity. */
	timeoutMs?: number;
	pollIntervalMs?: number;
	onProgress?: (activity: Activity, messages: string[]) => void;
}

export interface ActivityOutcome {
	activity: Activity;
	messages: string[];
	/** False when the activity reached a failed/cancelled state or timed out. */
	ok: boolean;
	timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const PAGE_LIMIT = 100;

export class ArcaneClient {
	/** Base URL including the `/api` prefix. */
	readonly apiBase: string;
	/** Base URL without `/api`, for building UI links. */
	readonly host: string;
	private readonly apiKey: string;

	constructor(host: string, apiKey: string) {
		this.host = host.replace(/\/+$/, "");
		this.apiBase = `${this.host}/api`;
		this.apiKey = apiKey;
	}

	// -----------------------------------------------------------------------
	// Transport
	// -----------------------------------------------------------------------

	private buildUrl(path: string, query?: RequestOptions["query"]): string {
		const url = new URL(`${this.apiBase}${path}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value === undefined) continue;
			url.searchParams.set(key, String(value));
		}
		return url.toString();
	}

	private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
		const { query, body, signal, raw, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
		const url = this.buildUrl(path, query);

		// Combine the caller's signal with our own timeout so either can cancel.
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });

		let response: Response;
		try {
			response = await fetch(url, {
				method,
				headers: {
					"X-API-Key": this.apiKey,
					Accept: "application/json",
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (error) {
			if (signal?.aborted) throw new Error(`Arcane ${method} ${path} cancelled`);
			if (controller.signal.aborted) {
				throw new Error(`Arcane ${method} ${path} timed out after ${timeoutMs}ms`);
			}
			throw new Error(`Arcane ${method} ${path} failed: ${(error as Error).message}`);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}

		const text = await response.text();

		if (!response.ok) {
			let title: string | undefined;
			let detail: string | undefined;
			try {
				const problem = JSON.parse(text) as ErrorModel & {
					data?: { error?: string };
					error?: string;
				};
				title = problem.title;
				detail =
					problem.detail ??
					problem.data?.error ??
					problem.error ??
					problem.errors?.map((e) => `${e.location ?? ""} ${e.message ?? ""}`.trim()).join("; ");
			} catch {
				detail = text.slice(0, 500) || undefined;
			}
			throw new ArcaneApiError({
				status: response.status,
				method,
				path,
				title,
				detail,
				body: text.slice(0, 2000),
			});
		}

		if (raw) return text as unknown as T;
		if (!text) return undefined as unknown as T;

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			// Some endpoints (image build) stream progress rather than JSON.
			return text as unknown as T;
		}

		// Unwrap `{ success, data }` when present; otherwise hand back the body.
		if (parsed && typeof parsed === "object" && "data" in parsed && "success" in parsed) {
			const envelope = parsed as BaseApiResponse<T>;
			if (envelope.success === false) {
				throw new ArcaneApiError({
					status: response.status,
					method,
					path,
					detail: JSON.stringify(envelope.data).slice(0, 500),
					body: text.slice(0, 2000),
				});
			}
			return envelope.data;
		}

		return parsed as T;
	}

	/** Walk a paginated collection and return every item. */
	private async requestAllPages<T>(
		path: string,
		options: RequestOptions = {},
	): Promise<T[]> {
		const items: T[] = [];
		let start = 0;

		for (;;) {
			const page = await this.requestEnvelope<BasePaginated<T>>("GET", path, {
				...options,
				query: { ...options.query, start, limit: PAGE_LIMIT },
			});
			items.push(...(page.data ?? []));

			const total = page.pagination?.totalItems ?? items.length;
			if (items.length >= total || (page.data ?? []).length === 0) break;
			start += PAGE_LIMIT;
			// Defensive stop: never loop more than 100 pages.
			if (start > PAGE_LIMIT * 100) break;
		}

		return items;
	}

	/**
	 * Like `request`, but keeps the whole envelope. Needed for paginated and
	 * counted responses, where `data` alone loses the pagination metadata.
	 */
	private async requestEnvelope<T>(
		method: string,
		path: string,
		options: RequestOptions = {},
	): Promise<T> {
		const { query, body, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
		const url = this.buildUrl(path, query);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });

		let response: Response;
		try {
			response = await fetch(url, {
				method,
				headers: {
					"X-API-Key": this.apiKey,
					Accept: "application/json",
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (error) {
			if (signal?.aborted) throw new Error(`Arcane ${method} ${path} cancelled`);
			if (controller.signal.aborted) {
				throw new Error(`Arcane ${method} ${path} timed out after ${timeoutMs}ms`);
			}
			throw new Error(`Arcane ${method} ${path} failed: ${(error as Error).message}`);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}

		const text = await response.text();
		if (!response.ok) {
			let title: string | undefined;
			let detail: string | undefined;
			try {
				const problem = JSON.parse(text) as ErrorModel & { data?: { error?: string } };
				title = problem.title;
				detail = problem.detail ?? problem.data?.error;
			} catch {
				detail = text.slice(0, 500) || undefined;
			}
			throw new ArcaneApiError({
				status: response.status,
				method,
				path,
				title,
				detail,
				body: text.slice(0, 2000),
			});
		}

		return JSON.parse(text) as T;
	}

	/** Cheap credential check used by `/arcane-setup`. */
	async testConnection(signal?: AbortSignal): Promise<void> {
		await this.request<unknown>("GET", "/environments", {
			query: { limit: 1 },
			signal,
			timeoutMs: 20_000,
		});
	}

	// -----------------------------------------------------------------------
	// Environments
	// -----------------------------------------------------------------------

	listEnvironments(signal?: AbortSignal): Promise<Environment[]> {
		return this.requestAllPages<Environment>("/environments", { signal });
	}

	getEnvironment(id: string, signal?: AbortSignal): Promise<Environment> {
		return this.request<Environment>("GET", `/environments/${enc(id)}`, { signal });
	}

	/** Aggregate counts and action items for the environment. */
	getDashboard(id: string, signal?: AbortSignal): Promise<DashboardSnapshot> {
		return this.request<DashboardSnapshot>("GET", `/environments/${enc(id)}/dashboard`, { signal });
	}

	// -----------------------------------------------------------------------
	// Projects
	// -----------------------------------------------------------------------

	listProjects(envId: string, signal?: AbortSignal): Promise<ProjectDetails[]> {
		return this.requestAllPages<ProjectDetails>(`/environments/${enc(envId)}/projects`, { signal });
	}

	createProject(
		envId: string,
		req: CreateProjectRequest,
		signal?: AbortSignal,
	): Promise<CreateProjectResponse> {
		return this.request<CreateProjectResponse>("POST", `/environments/${enc(envId)}/projects`, {
			body: req,
			signal,
		});
	}

	getProject(envId: string, projectId: string, signal?: AbortSignal): Promise<ProjectDetails> {
		return this.request<ProjectDetails>(
			"GET",
			`/environments/${enc(envId)}/projects/${enc(projectId)}`,
			{ signal },
		);
	}

	updateProject(
		envId: string,
		projectId: string,
		req: UpdateProjectRequest,
		signal?: AbortSignal,
	): Promise<ProjectDetails> {
		return this.request<ProjectDetails>(
			"PUT",
			`/environments/${enc(envId)}/projects/${enc(projectId)}`,
			{ body: req, signal },
		);
	}

	buildProject(
		envId: string,
		projectId: string,
		req: BuildProjectRequest = {},
		signal?: AbortSignal,
	): Promise<string> {
		return this.request<string>(
			"POST",
			`/environments/${enc(envId)}/projects/${enc(projectId)}/build`,
			{ body: req, signal, raw: true, timeoutMs: 30 * 60_000 },
		);
	}

	deployProject(
		envId: string,
		projectId: string,
		req: DeployOptions = {},
		signal?: AbortSignal,
	): Promise<string> {
		return this.request<string>(
			"POST",
			`/environments/${enc(envId)}/projects/${enc(projectId)}/up`,
			{ body: req, signal, raw: true, timeoutMs: 30 * 60_000 },
		);
	}

	redeployProject(
		envId: string,
		projectId: string,
		req: DeployOptions = {},
		signal?: AbortSignal,
	): Promise<string> {
		return this.request<string>(
			"POST",
			`/environments/${enc(envId)}/projects/${enc(projectId)}/redeploy`,
			{ body: req, signal, raw: true, timeoutMs: 30 * 60_000 },
		);
	}

	stopProject(envId: string, projectId: string, signal?: AbortSignal): Promise<MessageResponse> {
		return this.request<MessageResponse>(
			"POST",
			`/environments/${enc(envId)}/projects/${enc(projectId)}/down`,
			{ signal, timeoutMs: 10 * 60_000 },
		);
	}

	destroyProject(
		envId: string,
		projectId: string,
		req: DestroyOptions = {},
		signal?: AbortSignal,
	): Promise<MessageResponse> {
		return this.request<MessageResponse>(
			"DELETE",
			`/environments/${enc(envId)}/projects/${enc(projectId)}/destroy`,
			{ body: req, signal, timeoutMs: 10 * 60_000 },
		);
	}

	// -----------------------------------------------------------------------
	// Images
	// -----------------------------------------------------------------------

	/** Streams BuildKit progress as its response body rather than JSON. */
	buildImage(envId: string, req: BuildRequest, signal?: AbortSignal): Promise<string> {
		return this.request<string>("POST", `/environments/${enc(envId)}/images/build`, {
			body: req,
			signal,
			raw: true,
			timeoutMs: 30 * 60_000,
		});
	}

	getBuild(envId: string, buildId: string, signal?: AbortSignal): Promise<ImageBuildRecord> {
		return this.request<ImageBuildRecord>(
			"GET",
			`/environments/${enc(envId)}/images/builds/${enc(buildId)}`,
			{ signal },
		);
	}

	listBuilds(envId: string, signal?: AbortSignal): Promise<ImageBuildRecord[]> {
		return this.requestAllPages<ImageBuildRecord>(`/environments/${enc(envId)}/images/builds`, {
			signal,
		});
	}

	listImages(envId: string, signal?: AbortSignal): Promise<ImageSummary[]> {
		return this.requestAllPages<ImageSummary>(`/environments/${enc(envId)}/images`, { signal });
	}

	/**
	 * Pull `image` onto the environment's host. The API takes name and tag
	 * separately, so a `name:tag` reference is split here — taking care not to
	 * mistake a registry port (`host:5000/img`) for a tag.
	 */
	pullImage(envId: string, image: string, signal?: AbortSignal): Promise<string> {
		const lastColon = image.lastIndexOf(":");
		const hasTag = lastColon > image.lastIndexOf("/");
		const imageName = hasTag ? image.slice(0, lastColon) : image;
		const tag = hasTag ? image.slice(lastColon + 1) : undefined;

		return this.request<string>("POST", `/environments/${enc(envId)}/images/pull`, {
			body: { imageName, ...(tag ? { tag } : {}) },
			signal,
			raw: true,
			timeoutMs: 15 * 60_000,
		});
	}

	// -----------------------------------------------------------------------
	// Activities
	// -----------------------------------------------------------------------

	listActivities(envId: string, signal?: AbortSignal): Promise<Activity[]> {
		return this.requestAllPages<Activity>(`/environments/${enc(envId)}/activities`, { signal });
	}

	getActivity(
		envId: string,
		activityId: string,
		limit = 200,
		signal?: AbortSignal,
	): Promise<ActivityDetail> {
		return this.request<ActivityDetail>(
			"GET",
			`/environments/${enc(envId)}/activities/${enc(activityId)}`,
			{ query: { limit }, signal },
		);
	}

	cancelActivity(envId: string, activityId: string, signal?: AbortSignal): Promise<MessageResponse> {
		return this.request<MessageResponse>(
			"POST",
			`/environments/${enc(envId)}/activities/${enc(activityId)}/cancel`,
			{ signal },
		);
	}

	/**
	 * Poll an activity until it reaches a terminal status (plan phase 6.4).
	 * On timeout the activity is cancelled so it does not linger.
	 */
	async waitForActivity(
		envId: string,
		activityId: string,
		options: WaitForActivityOptions = {},
	): Promise<ActivityOutcome> {
		const { signal, timeoutMs = 20 * 60_000, pollIntervalMs = 2000, onProgress } = options;
		const deadline = Date.now() + timeoutMs;
		let seenMessages = 0;
		let last: ActivityDetail | undefined;

		for (;;) {
			last = await this.getActivity(envId, activityId, 200, signal);
			const messages = (last.messages ?? []).map((m) => m.message);
			if (onProgress && messages.length > seenMessages) {
				onProgress(last.activity, messages.slice(seenMessages));
				seenMessages = messages.length;
			}

			const status = (last.activity.status ?? "").toLowerCase();
			if (TERMINAL_ACTIVITY_STATUSES.has(status)) {
				return {
					activity: last.activity,
					messages,
					ok: !FAILED_ACTIVITY_STATUSES.has(status),
					timedOut: false,
				};
			}

			if (signal?.aborted) {
				return { activity: last.activity, messages, ok: false, timedOut: false };
			}

			if (Date.now() >= deadline) {
				try {
					await this.cancelActivity(envId, activityId, signal);
				} catch {
					// Best effort — report the timeout regardless.
				}
				return { activity: last.activity, messages, ok: false, timedOut: true };
			}

			await sleep(pollIntervalMs, signal);
		}
	}

	// -----------------------------------------------------------------------
	// Containers
	// -----------------------------------------------------------------------

	async listContainers(envId: string, signal?: AbortSignal): Promise<ContainerSummary[]> {
		const items: ContainerSummary[] = [];
		let start = 0;
		for (;;) {
			const page = await this.requestEnvelope<ContainerListResponse>(
				"GET",
				`/environments/${enc(envId)}/containers`,
				{ query: { start, limit: PAGE_LIMIT }, signal },
			);
			items.push(...(page.data ?? []));
			const total = page.pagination?.totalItems ?? items.length;
			if (items.length >= total || (page.data ?? []).length === 0) break;
			start += PAGE_LIMIT;
			if (start > PAGE_LIMIT * 100) break;
		}
		return items;
	}

	getContainer(
		envId: string,
		containerId: string,
		signal?: AbortSignal,
	): Promise<ContainerDetails> {
		return this.request<ContainerDetails>(
			"GET",
			`/environments/${enc(envId)}/containers/${enc(containerId)}`,
			{ signal },
		);
	}

	// -----------------------------------------------------------------------
	// Volume browsing
	//
	// The upload sidecar owns writes; these cover what it cannot do — listing an
	// uploaded context and deleting files that have left the working tree, since
	// the sidecar exposes no DELETE.
	// -----------------------------------------------------------------------

	listVolumeFiles(
		envId: string,
		volume: string,
		path: string,
		signal?: AbortSignal,
	): Promise<VolumeFileEntry[]> {
		return this.request<VolumeFileEntry[]>(
			"GET",
			`/environments/${enc(envId)}/volumes/${enc(volume)}/browse`,
			{ query: { path }, signal },
		);
	}

	/** Recursive: removing a directory removes everything under it. */
	deleteVolumePath(
		envId: string,
		volume: string,
		path: string,
		signal?: AbortSignal,
	): Promise<void> {
		return this.request<void>(
			"DELETE",
			`/environments/${enc(envId)}/volumes/${enc(volume)}/browse`,
			{ query: { path }, signal, timeoutMs: 2 * 60_000 },
		);
	}

	redeployContainer(
		envId: string,
		containerId: string,
		signal?: AbortSignal,
	): Promise<MessageResponse> {
		return this.request<MessageResponse>(
			"POST",
			`/environments/${enc(envId)}/containers/${enc(containerId)}/redeploy`,
			{ signal, timeoutMs: 10 * 60_000 },
		);
	}

	restartContainer(
		envId: string,
		containerId: string,
		signal?: AbortSignal,
	): Promise<MessageResponse> {
		return this.request<MessageResponse>(
			"POST",
			`/environments/${enc(envId)}/containers/${enc(containerId)}/restart`,
			{ signal, timeoutMs: 5 * 60_000 },
		);
	}

	// -----------------------------------------------------------------------
	// Logs (WebSocket only — no REST equivalent exists)
	// -----------------------------------------------------------------------

	private logsUrl(path: string, options: LogOptions): string {
		const url = new URL(`${this.apiBase}${path}`);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		// follow=false makes the server send the tail and close.
		url.searchParams.set("follow", "false");
		url.searchParams.set("tail", String(options.tail ?? 100));
		url.searchParams.set("timestamps", String(options.timestamps ?? false));
		url.searchParams.set("format", "text");
		if (options.since) url.searchParams.set("since", options.since);
		return url.toString();
	}

	private async collectLogs(path: string, options: LogOptions): Promise<string> {
		const result = await collectWebSocketMessages(this.logsUrl(path, options), {
			headers: { "X-API-Key": this.apiKey },
			signal: options.signal,
			timeoutMs: options.timeoutMs ?? 30_000,
			maxMessages: Math.max((options.tail ?? 100) * 4, 500),
		});
		const text = result.messages.join("").replace(/\r\n/g, "\n");
		return result.truncated ? `${text}\n[log stream truncated]` : text;
	}

	getContainerLogs(envId: string, containerId: string, options: LogOptions = {}): Promise<string> {
		return this.collectLogs(
			`/environments/${enc(envId)}/ws/containers/${enc(containerId)}/logs`,
			options,
		);
	}

	getProjectLogs(envId: string, projectId: string, options: LogOptions = {}): Promise<string> {
		return this.collectLogs(
			`/environments/${enc(envId)}/ws/projects/${enc(projectId)}/logs`,
			options,
		);
	}
}

function enc(segment: string): string {
	return encodeURIComponent(segment);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}
