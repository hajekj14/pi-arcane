/**
 * TypeScript models for the Arcane REST API (Arcane 2.6.0, OpenAPI 3.1).
 *
 * These mirror `components.schemas` from `<host>/api/openapi.json`. Only the
 * fields this extension actually reads are declared; the API returns more.
 * Optional here means "the API marks it optional" — required fields are the
 * ones listed in the spec's `required` array.
 */

// ---------------------------------------------------------------------------
// Response envelopes
// ---------------------------------------------------------------------------

export interface BaseApiResponse<T> {
	success: boolean;
	data: T;
}

export interface PaginationResponse {
	totalPages: number;
	totalItems: number;
	currentPage: number;
	itemsPerPage: number;
	grandTotalItems?: number;
}

export interface BasePaginated<T> {
	success: boolean;
	data: T[] | null;
	pagination: PaginationResponse;
}

export interface MessageResponse {
	message: string;
	/** Background activity ID tracking this action, when the call is async. */
	activityId?: string;
}

/** RFC 7807 problem document returned as `application/problem+json`. */
export interface ErrorModel {
	type?: string;
	title?: string;
	status?: number;
	detail?: string;
	instance?: string;
	errors?: Array<{ location?: string; message?: string; value?: unknown }>;
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export interface Environment {
	id: string;
	apiUrl: string;
	status: string;
	enabled: boolean;
	isEdge: boolean;
	name?: string;
	connected?: boolean;
	lastSeen?: string;
}

// ---------------------------------------------------------------------------
// Volume browsing (how uploaded build contexts are inspected and pruned)
// ---------------------------------------------------------------------------

/** One entry from `GET /environments/{id}/volumes/{name}/browse`. */
export interface VolumeFileEntry {
	name: string;
	path: string;
	size: number;
	isDirectory: boolean;
	isSymlink: boolean;
	mode?: string;
	/** Uploaded files report the zero time; never use it for change detection. */
	modTime?: string;
	linkTarget?: string;
}

/** One mount of a container, as reported by `GET .../containers/{id}`. */
export interface ContainerMount {
	type: string;
	destination: string;
	source?: string;
	name?: string;
	rw?: boolean;
}

// ---------------------------------------------------------------------------
// Deploy shapes
// ---------------------------------------------------------------------------

/**
 * What the uploaded tree turns into: a compose project built from the uploaded
 * context, or a single image plus a generated one-service compose project.
 */
export type DeployShape = "compose" | "container";

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface RuntimeService {
	name: string;
	image: string;
	status: string;
	containerId?: string;
	containerName?: string;
	health?: string;
	ports?: string[] | null;
}

export interface ProjectDetails {
	id: string;
	name: string;
	path: string;
	status: string;
	serviceCount: number;
	runningCount: number;
	isArchived: boolean;
	createdAt: string;
	updatedAt: string;
	activityId?: string;
	composeContent?: string;
	composeFileName?: string;
	envContent?: string;
	statusReason?: string;
	gitOpsManagedBy?: string;
	gitRepositoryURL?: string;
	lastSyncCommit?: string;
	hasBuildDirective?: boolean;
	runtimeServices?: RuntimeService[] | null;
	urls?: string[] | null;
}

export interface CreateProjectRequest {
	name: string;
	composeContent: string;
	envContent?: string;
}

export interface CreateProjectResponse {
	id: string;
	name: string;
	path: string;
	status: string;
	serviceCount: number;
	runningCount: number;
	isArchived: boolean;
	createdAt: string;
	updatedAt: string;
	activityId?: string;
}

export interface UpdateProjectRequest {
	name?: string;
	composeContent?: string;
	envContent?: string;
	overrideContent?: string;
}

export interface DeployOptions {
	forceRecreate?: boolean;
	pullPolicy?: string;
	removeOrphans?: boolean;
}

export interface DestroyOptions {
	removeFiles?: boolean;
	removeVolumes?: boolean;
}

export interface BuildProjectRequest {
	services?: string[];
	push?: boolean;
	load?: boolean;
	provider?: string;
}

// ---------------------------------------------------------------------------
// Images / builds
// ---------------------------------------------------------------------------

export interface BuildRequest {
	/** Build context directory on the Docker host, or a Git URL. */
	contextDir: string;
	dockerfile?: string;
	dockerfileInline?: string;
	tags?: string[];
	buildArgs?: Record<string, string>;
	labels?: Record<string, string>;
	platforms?: string[];
	target?: string;
	noCache?: boolean;
	pull?: boolean;
	push?: boolean;
	load?: boolean;
	provider?: string;
}

export interface ImageSummary {
	id: string;
	repoTags?: string[] | null;
	repoDigests?: string[] | null;
	created?: number;
	size?: number;
	inUse?: boolean;
	repo?: string;
	tag?: string;
}

export interface ImageBuildRecord {
	id: string;
	environmentId: string;
	contextDir: string;
	status: string;
	createdAt: string;
	load: boolean;
	noCache: boolean;
	privileged: boolean;
	pull: boolean;
	push: boolean;
	outputTruncated: boolean;
	tags?: string[] | null;
	dockerfile?: string;
	digest?: string;
	output?: string;
	errorMessage?: string;
	completedAt?: string;
	durationMs?: number;
	buildArgs?: Record<string, string>;
	provider?: string;
}

// ---------------------------------------------------------------------------
// Activities (background tasks)
// ---------------------------------------------------------------------------

/** Activity statuses Arcane treats as final. */
export const TERMINAL_ACTIVITY_STATUSES = new Set([
	"completed",
	"complete",
	"success",
	"succeeded",
	"failed",
	"failure",
	"error",
	"cancelled",
	"canceled",
]);

/** Terminal statuses that mean the activity did not succeed. */
export const FAILED_ACTIVITY_STATUSES = new Set([
	"failed",
	"failure",
	"error",
	"cancelled",
	"canceled",
]);

export interface Activity {
	id: string;
	environmentId: string;
	type: string;
	status: string;
	createdAt: string;
	startedAt: string;
	updatedAt?: string;
	endedAt?: string;
	durationMs?: number;
	progress?: number;
	step?: string;
	latestMessage?: string;
	error?: string;
	resourceId?: string;
	resourceName?: string;
	resourceType?: string;
	metadata?: Record<string, unknown>;
}

export interface ActivityMessage {
	id: string;
	activityId: string;
	level: string;
	message: string;
	createdAt: string;
	payload?: Record<string, unknown>;
}

export interface ActivityDetail {
	activity: Activity;
	messages: ActivityMessage[] | null;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/**
 * `containers` and `images` are full paginated collections, each carrying its
 * own counts — not plain totals.
 */
export interface DashboardSnapshot {
	containers: {
		counts: ContainerStatusCounts;
		data: ContainerSummary[] | null;
		pagination: PaginationResponse;
	};
	images: { data: unknown[] | null; pagination: PaginationResponse };
	actionItems?: { items?: Array<{ kind: string; count: number; severity: string }> | null };
	versionInfo?: { version?: string };
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export interface ContainerPort {
	privatePort: number;
	type: string;
	ip?: string;
	publicPort?: number;
}

export interface ContainerSummary {
	id: string;
	names: string[] | null;
	image: string;
	imageId: string;
	command: string;
	created: number;
	state: string;
	status: string;
	labels: Record<string, string>;
	ports: ContainerPort[] | null;
}

export interface ContainerStatusCounts {
	totalContainers: number;
	runningContainers: number;
	stoppedContainers: number;
}

export interface ContainerListResponse {
	success: boolean;
	data: ContainerSummary[] | null;
	counts: ContainerStatusCounts;
	pagination: PaginationResponse;
}

export interface ContainerState {
	running: boolean;
	status: string;
	exitCode?: number;
	startedAt?: string;
	finishedAt?: string;
	health?: { status?: string };
}

export interface ContainerDetails {
	id: string;
	name: string;
	image: string;
	imageId: string;
	created: string;
	state: ContainerState;
	ports: ContainerPort[] | null;
	labels?: Record<string, string>;
	/** Used to discover which volume backs the upload directory. */
	mounts?: ContainerMount[] | null;
	composeInfo?: {
		projectName: string;
		serviceName: string;
		workingDir?: string;
	};
}

// ---------------------------------------------------------------------------
// Extension-local state persisted into the pi session
// ---------------------------------------------------------------------------

/** One recorded deploy, appended to the session as a custom entry. */
export interface DeploymentRecord {
	timestamp: string;
	environmentId: string;
	projectName: string;
	projectId?: string;
	branch?: string;
	composePath?: string;
	targetType?: DeployShape;
	/** Absolute path of the uploaded build context inside Arcane. */
	contextPath?: string;
	/** What the upload moved: files sent, removed, and skipped as unchanged. */
	upload?: { uploaded: number; deleted: number; unchanged: number; bytes: number };
	status: "success" | "failed";
	error?: string;
	urls?: string[];
	containers?: Array<{ name: string; state: string; url?: string }>;
}

export const DEPLOYMENT_ENTRY_TYPE = "arcane-deployment";
