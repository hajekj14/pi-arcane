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
// Git repositories (global, under /customize/git-repositories)
// ---------------------------------------------------------------------------

export type GitAuthType = "none" | "token" | "ssh";

export interface GitRepository {
	id: string;
	name: string;
	url: string;
	authType: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	description?: string;
	username?: string;
	sshHostKeyVerification?: string;
}

export interface CreateGitRepositoryRequest {
	name: string;
	url: string;
	authType: GitAuthType;
	token?: string;
	username?: string;
	sshKey?: string;
	sshHostKeyVerification?: string;
	description?: string;
	enabled?: boolean;
}

export type UpdateGitRepositoryRequest = Partial<CreateGitRepositoryRequest>;

/**
 * A whole repository record as `POST /git-repositories/sync` expects them —
 * the endpoint takes objects, not IDs. Credentials are optional.
 */
export interface RepositorySync extends GitRepository {
	token?: string;
	sshKey?: string;
}

export interface BranchInfo {
	name: string;
	isDefault: boolean;
}

export interface BranchesResponse {
	branches: BranchInfo[] | null;
}

/** One entry when browsing a repository's tree. */
export interface FileTreeNode {
	name?: string;
	path?: string;
	type?: string;
	isDirectory?: boolean;
	size?: number;
}

/** Arcane has used both key names for the listing, so accept either. */
export interface BrowseResponse {
	entries?: FileTreeNode[] | null;
	files?: FileTreeNode[] | null;
	path?: string;
}

// ---------------------------------------------------------------------------
// GitOps syncs
// ---------------------------------------------------------------------------

export type SyncTargetType = "compose" | "container";

export interface GitOpsSync {
	id: string;
	name: string;
	environmentId: string;
	repositoryId: string;
	branch: string;
	composePath: string;
	projectName: string;
	targetType: string;
	autoSync: boolean;
	syncInterval: number;
	syncDirectory: boolean;
	createdAt: string;
	updatedAt: string;
	projectId?: string;
	lastSyncAt?: string;
	lastSyncCommit?: string;
	lastSyncError?: string;
	lastSyncStatus?: string;
	syncedFiles?: string;
	repository?: GitRepository;
	preDeployScriptPath?: string;
}

export interface CreateSyncRequest {
	name: string;
	repositoryId: string;
	branch: string;
	composePath: string;
	projectName?: string;
	targetType?: SyncTargetType;
	autoSync?: boolean;
	syncInterval?: number;
	syncDirectory?: boolean;
	preDeployScriptPath?: string;
	preDeployTimeoutSec?: number;
}

export type UpdateSyncRequest = Partial<CreateSyncRequest>;

export interface SyncResult {
	success: boolean;
	message: string;
	syncedAt: string;
	error?: string;
}

export interface SyncStatus {
	id: string;
	autoSync: boolean;
	lastSyncAt?: string;
	lastSyncCommit?: string;
	lastSyncError?: string;
	lastSyncStatus?: string;
	nextSyncAt?: string;
}

export interface SyncCounts {
	totalSyncs: number;
	activeSyncs: number;
	successfulSyncs: number;
}

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
	syncName?: string;
	syncId?: string;
	repositoryId?: string;
	projectId?: string;
	branch?: string;
	composePath?: string;
	targetType?: SyncTargetType;
	status: "success" | "failed";
	error?: string;
	urls?: string[];
	containers?: Array<{ name: string; state: string; url?: string }>;
}

export const DEPLOYMENT_ENTRY_TYPE = "arcane-deployment";
