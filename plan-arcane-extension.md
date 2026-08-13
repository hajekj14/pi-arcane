# Arcane Pi Extension — Implementation Plan

## Overview

A pi extension that enables end-to-end **develop → deploy** workflows through Arcane (<https://arcane.hajek.click>). The typical flow: clone a repo, develop in pi, commit to a branch, then ask pi to deploy — and the extension handles everything on the Arcane side via its REST API.

## Architecture

```
┌─────────────┐      ┌──────────────────┐      ┌─────────────────┐
│   pi shell  │      │  pi-arcane ext   │      │  Arcane API     │
│  (TUI/RPC)  │◄────►│  (TypeScript)    │─────►│  arcane.hajek.  │
│             │      │                  │HTTP  │  click/api      │
│  /deploy    │      │  • config read   │JSON  │                 │
│  arcane_*   │      │  • tools         │      │  Envs, GitOps,  │
│  tools      │      │  • state mgmt    │      │  Projects,      │
└─────────────┘      └──────────────────┘      │  Builds, etc.   │
                                               └─────────────────┘
```

## Phase 1 — Configuration Layer

### 1.1 Config file (`arcane.json`)

Place in project root or `.pi/arcane.json`. Read lazily on first use, cached for session.

**Minimal config** (everything else auto-detected):

```json
{
  "apiKey": "$ARCANE_API_KEY"
}
```

**Full config** (with all overrides):

```json
{
  "host": "https://arcane.hajek.click",
  "apiKey": "$ARCANE_API_KEY",
  "environmentId": "env_abc123",
  "defaults": {
    "autoSync": false,
    "syncInterval": 60,
    "composePath": "docker-compose.yml",
    "targetType": "compose",
    "projectName": "my-app",
    "syncName": "my-app-staging"
  }
}
```

- `host` — Arcane API base URL (default: `https://arcane.hajek.click`)
- `apiKey` — literal or `$ENV_VAR` / `${ENV_VAR}` interpolation **(required)**
- `environmentId` — target Arcane Docker environment ID **(optional)**. When omitted, the extension auto-discovers by calling `GET /environments` and either picks the only one or prompts the user to choose. The `/arcane-setup` wizard pre-populates this so it doesn't re-prompt every time.
- `defaults` — project-level overrides for GitOps sync creation **(optional)**. Every field is optional; the LLM infers values from the repo (e.g., scanning for `docker-compose.yml`, reading the current git branch) or from the user's prompt. Only configure these to force a specific value that should never be auto-detected:
  - `autoSync` — enable periodic GitOps polling (default: `false` for manual CI-style deploys)
  - `syncInterval` — seconds between polls if autoSync (default: 60)
  - `composePath` — override the compose file path instead of auto-detection
  - `targetType` — `"compose"` or `"container"`, default auto-detected from repo contents
  - `projectName` — override the project name in Arcane (default: repo name)
  - `syncName` — override the GitOps sync name (default: repo-name + branch)

**Resolution order** (first found wins):

1. `.pi/arcane.json` (project-local)
2. `arcane.json` (project root)
3. `~/.pi/agent/arcane.json` (global fallback)

### 1.2 Auth

- API key sent as `X-API-Key` header on every request
- Token can also be literal, env-interpolated, or `!command` (same semantics as provider apiKey)
- The extension registers a `/arcane-setup` command to validate and persist config interactively

### 1.3 Environment Resolution

When `environmentId` is not in config, the extension resolves it at tool-call time:

1. Call `GET /environments` with the configured API key
2. If exactly one environment exists → auto-select it and cache for the session
3. If multiple → present a `ctx.ui.select()` picker, cache the choice
4. If zero → return an error telling the user to create an environment in the Arcane UI first
5. The selected ID is cached in memory for the session and also persisted back to the first found `arcane.json` so subsequent sessions skip the prompt

---

## Phase 2 — Core Arcane Client

A thin typed HTTP client wrapping `fetch()`:

```typescript
class ArcaneClient {
  constructor(baseUrl: string, apiKey: string)

  // Git Repositories (global /customize/git-repositories)
  listRepositories(): Promise<GitRepository[]>
  createRepository(req: CreateGitRepositoryRequest): Promise<GitRepository>
  getRepository(id: string): Promise<GitRepository>
  updateRepository(id: string, req: UpdateGitRepositoryRequest): Promise<GitRepository>
  deleteRepository(id: string): Promise<void>
  testRepository(id: string): Promise<void>
  listBranches(id: string): Promise<BranchInfo[]>
  browseFiles(id: string, path?: string): Promise<FileTreeNode[]>
  syncRepositories(repos: RepositorySync[]): Promise<void>

  // Environments
  listEnvironments(): Promise<Environment[]>
  getEnvironment(id: string): Promise<Environment>

  // GitOps Syncs
  listGitOpsSyncs(envId: string): Promise<GitOpsSync[]>
  createGitOpsSync(envId: string, req: CreateSyncRequest): Promise<GitOpsSync>
  getGitOpsSync(envId: string, syncId: string): Promise<GitOpsSync>
  updateGitOpsSync(envId: string, syncId: string, req: UpdateSyncRequest): Promise<GitOpsSync>
  deleteGitOpsSync(envId: string, syncId: string): Promise<void>
  syncNow(envId: string, syncId: string): Promise<SyncResult>
  getSyncStatus(envId: string, syncId: string): Promise<SyncStatus>

  // Projects
  listProjects(envId: string): Promise<Project[]>
  createProject(envId: string, req: CreateProject): Promise<Project>
  getProject(envId: string, projectId: string): Promise<Project>
  updateProject(envId: string, projectId: string, req: UpdateProject): Promise<void>
  buildProject(envId: string, projectId: string): Promise<Activity>
  deployProject(envId: string, projectId: string): Promise<Activity>
  destroyProject(envId: string, projectId: string): Promise<void>

  // Images
  buildImage(envId: string, req: BuildRequest): Promise<ImageBuildRecord>
  getBuild(envId: string, buildId: string): Promise<ImageBuildRecord>
  listBuilds(envId: string): Promise<ImageBuildRecord[]>
  pullImage(envId: string, image: string): Promise<void>

  // Activities (background tasks)
  listActivities(envId: string): Promise<Activity[]>
  getActivity(envId: string, activityId: string): Promise<ActivityDetail>
  cancelActivity(envId: string, activityId: string): Promise<void>

  // Containers
  listContainers(envId: string): Promise<Container[]>
  getContainer(envId: string, containerId: string): Promise<ContainerDetails>
  redeployContainer(envId: string, containerId: string): Promise<Activity>
  getContainerLogs(envId: string, containerId: string): Promise<string>
}
```

---

## Phase 3 — Pi Tools

### 3.1 `arcane_deploy` — Main Deploy Tool

The primary tool the LLM calls. Implements the full deploy workflow:

```
Inputs:
  - git_url: string          (HTTPS repo URL with embedded token, e.g. https://token:@gitlab.com/...)
  - branch: string           (branch to deploy, default: current git branch)
  - compose_path: string     (path to docker-compose.yml, default: auto-detect)
  - project_name: string     (Arcane project name, default: repo name)
  - sync_name: string        (GitOps sync name, default: repo-name + branch)
  - dockerfile: string?      (Dockerfile path if not using compose)
  - build_args: object?      (build-time args)
  - env_vars: object?        (environment variables)
  - ports: string[]?         (port mappings for single-container deploys)
```

**Workflow:**

1. **Detect repo** — read git remote origin URL from local checkout (`git config --get remote.origin.url`)
2. **Detect branch** — read current branch (`git branch --show-current`)  
3. **Detect compose file** — scan for `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, `Dockerfile*`
4. **Register git repository in Arcane** — `POST /customize/git-repositories` with `authType: "token"`, embedded token in URL
5. **Create or update GitOps sync** — `POST /environments/{id}/gitops-syncs` pointing at the repo, branch, compose path
6. **Trigger sync** — `POST /environments/{id}/gitops-syncs/{syncId}/sync`
7. **Monitor activity** — poll `GET /environments/{id}/activities/{activityId}` until terminal status
8. **Report** — return project URL, container endpoints, any errors

### 3.2 `arcane_status` — Status Check

```
Inputs:
  - project_name?: string    (filter by project)
  - sync_name?: string       (filter by sync)
```

Returns: list of projects/syncs with their current status, last sync time, running containers.

### 3.3 `arcane_build` — Image Build Only

```
Inputs:
  - dockerfile_path: string
  - context_dir: string      (default: repo root)
  - tags: string[]
  - build_args: object?
```

Uses `POST /environments/{id}/images/build` to build without deploying.

### 3.4 `arcane_logs` — Container Logs

```
Inputs:
  - container_id: string
  - tail?: number
```

### 3.5 `arcane_list` — List Resources

List projects, syncs, containers in the configured environment.

---

## Phase 4 — Commands

### `/arcane-setup`

Interactive wizard to configure `arcane.json`:

1. Prompt for Arcane host URL
2. Prompt for API key (secret input)
3. List environments → select target
4. Optionally test connection
5. Write config

### `/arcane-status`

Quick TUI dashboard showing:

- Environment status
- Active projects
- Recent syncs  
- Running containers and their URLs

---

## Phase 5 — Repo Layout & Development

### 5.1 Repo structure

The extension lives in this repo (`pi-arcane`) so it can be tested inline with `pi -e`:

```
pi-arcane/
├── plan-arcane-extension.md   # This document
├── extension.ts               # Single-file extension (Phase 5.2)
├── .pi/
│   └── arcane.json            # Dev config (gitignored — contains API key)
├── .gitignore
└── README.md
```

### 5.2 Development approach

**Start as a single file** (`extension.ts`) for rapid iteration. Pi's `jiti` loader handles TypeScript natively:

```bash
pi -e ./extension.ts
```

Once the extension grows beyond ~500 lines, split into a directory structure:

```
pi-arcane/
├── extension/
│   ├── index.ts              # Entry — registers tools, commands, events
│   ├── client.ts             # ArcaneClient class — typed HTTP wrapper
│   ├── config.ts             # Config loader — resolution order, env interpolation
│   ├── tools/
│   │   ├── deploy.ts         # arcane_deploy tool
│   │   ├── status.ts         # arcane_status tool
│   │   ├── build.ts          # arcane_build tool
│   │   ├── logs.ts           # arcane_logs tool
│   │   └── list.ts           # arcane_list tool
│   ├── commands/
│   │   ├── setup.ts          # /arcane-setup wizard
│   │   └── status.ts         # /arcane-status dashboard
│   └── types.ts              # TypeBox schemas + TypeScript types
├── .pi/
│   └── arcane.json
└── plan-arcane-extension.md
```

Then run with:

```bash
pi -e ./extension
```

### 5.3 .gitignore

```gitignore
# Sensitive config
.pi/arcane.json

# Pi sessions
.pi/sessions/

# Node (only if directory layout with package.json)
extension/node_modules/
```

---

## Phase 6 — Detailed Implementation Notes

### 6.1 Git Repository Registration

Arcane needs to clone the repo. The git URL must include credentials:

- **HTTPS with token**: `https://oauth2:TOKEN@github.com/user/repo.git` or `https://TOKEN:@gitlab.com/user/repo.git`
- **SSH key**: register SSH key via `sshKey` field in `CreateGitRepositoryRequest`

The extension should:

1. Read the remote origin URL from `git config --get remote.origin.url`
2. If already an HTTPS URL with embedded credentials, use as-is
3. If an SSH URL (`git@...`), either:
   - Convert to HTTPS and prompt for token, or
   - Register as SSH with `authType: "ssh"` and upload the key
4. If a plain HTTPS URL without credentials, prompt for token and embed it

### 6.2 GitOps Sync Configuration

`GitopsCreateSyncRequest` requires:

- `name` — human-readable sync name
- `repositoryId` — from step 1
- `branch` — the branch to deploy
- `composePath` — docker-compose.yml location in repo
- `autoSync` — enable periodic polling (recommended: `false` for manual CI-style deploys)
- `syncInterval` — seconds between polls (if autoSync)
- `projectName` — Arcane project to create/update
- `targetType` — `"compose"` for multi-service, `"container"` for single

### 6.3 Build Flow

For **Docker Compose** projects:

- Create GitOps sync → sync pulls the compose file → Arcane detects `build:` directives → builds with BuildKit
- Alternative: `POST /environments/{id}/projects/{projectId}/build` to trigger builds explicitly

For **single Dockerfile** projects:

- Use `POST /environments/{id}/images/build` with `contextDir` as git URL + branch ref
- Or upload Dockerfile + context directly via build workspace browse endpoints

### 6.4 Activity Monitoring

Long-running operations (syncs, builds, deploys) return an `activityId`. Poll with:

```
GET /environments/{id}/activities/{activityId}
```

Until `status` is terminal (`completed`, `failed`, `cancelled`). Show progress messages from `latestMessage` and `progress` fields.

### 6.5 Error Handling

- Wrap all HTTP calls in try/catch — return clear error messages to LLM
- Surface Arcane error responses (`BaseApiResponse` with `success: false`)
- Handle common cases: repo auth failures, branch not found, compose parse errors, build failures
- Timeout handling for long builds — cancel via `POST .../activities/{id}/cancel`

### 6.6 State Persistence

Store deployment state in session via `pi.appendEntry()` so the LLM can track:

- Which repos/syncs were created
- Last deployment status
- Created resource IDs for cleanup

---

## Phase 7 — Future Enhancements

1. **`/arcane-destroy`** — tear down a project and its resources
2. **`arcane_update`** — update project compose/env and redeploy
3. **Multi-environment** — switch between dev/staging/prod Arcane environments
4. **Webhook CI** — register Arcane webhooks to auto-deploy on push
5. **SSH support** — deploy to remote Arcane instance if running pi via SSH extension
6. **Pre-deploy scripts** — use Arcane's `preDeployScriptPath` for DB migrations, etc.
7. **Template support** — pull Arcane templates and customize
8. **Volume backup/restore** — backup before deploy, restore on rollback

---

## API Authentication

Arcane uses `X-API-Key` header. API keys are created in the Arcane UI.
Authentication also supports JWT Bearer tokens (`/auth/login`, `/auth/refresh`), but API keys are preferred for automation.

---

## Key Arcane API Endpoints Used

| Endpoint | Method | Purpose |
| ---------- | -------- | --------- |
| `/customize/git-repositories` | GET/POST | Register git repos |
| `/customize/git-repositories/{id}/branches` | GET | List branches |
| `/customize/git-repositories/{id}/test` | POST | Test repo connection |
| `/environments/{id}` | GET | Get environment info |
| `/environments/{id}/gitops-syncs` | GET/POST | Manage GitOps syncs |
| `/environments/{id}/gitops-syncs/{sid}/sync` | POST | Trigger sync |
| `/environments/{id}/gitops-syncs/{sid}/status` | GET | Sync status |
| `/environments/{id}/projects` | GET/POST | Manage projects |
| `/environments/{id}/projects/{pid}/build` | POST | Build project |
| `/environments/{id}/projects/{pid}/up` | POST | Deploy project |
| `/environments/{id}/projects/{pid}/down` | POST | Stop project |
| `/environments/{id}/projects/{pid}/destroy` | DELETE | Destroy project |
| `/environments/{id}/images/build` | POST | Build single image |
| `/environments/{id}/images/builds` | GET | List builds |
| `/environments/{id}/images/builds/{bid}` | GET | Build status |
| `/environments/{id}/containers` | GET | List containers |
| `/environments/{id}/containers/{cid}` | GET | Container details |
| `/environments/{id}/activities` | GET | List activities |
| `/environments/{id}/activities/{aid}` | GET | Activity detail + messages |
| `/environments/{id}/activities/{aid}/cancel` | POST | Cancel activity |
| `/environments/{id}/dashboard` | GET | Dashboard snapshot |

---

## Phase 8 — E2E Test Fixtures

Two minimal test apps to validate the complete extension workflow end-to-end. Each is a tiny repo that serves a static HTML page.

### 8.1 Docker Compose test (`test-fixtures/compose-app/`)

```
test-fixtures/compose-app/
├── docker-compose.yml
├── Dockerfile
└── www/
    └── index.html
```

**docker-compose.yml:**

```yaml
services:
  web:
    build: .
    ports:
      - "5553:80"
```

**Dockerfile:**

```dockerfile
FROM nginx:alpine
COPY www/ /usr/share/nginx/html/
```

**www/index.html:**

```html
<!DOCTYPE html>
<html><head><title>Compose Test</title></head>
<body><h1>Compose Deploy Works!</h1></body>
</html>
```

### 8.2 Single Dockerfile test (`test-fixtures/dockerfile-app/`)

```
test-fixtures/dockerfile-app/
├── Dockerfile
└── www/
    └── index.html
```

**Dockerfile:**

```dockerfile
FROM nginx:alpine
COPY www/ /usr/share/nginx/html/
EXPOSE 80
```

**www/index.html:**

```html
<!DOCTYPE html>
<html><head><title>Dockerfile Test</title></head>
<body><h1>Dockerfile Deploy Works!</h1></body>
</html>
```

### 8.3 E2E Test Flow

For each fixture, run through the full develop → deploy cycle:

1. **Init repo** — `cd test-fixtures/compose-app && git init && git add -A && git commit -m "init"`
2. **Push to remote** — push to a real GitLab/GitHub repo (needed because Arcane clones from remote)
3. **Open pi** — `cd test-fixtures/compose-app && pi -e ../../extension.ts`
4. **Make a change** — ask pi to edit the HTML (e.g., change "Works!" to "Works! v2")
5. **Commit** — pi commits the change
6. **Deploy** — `deploy this to Arcane on branch main`
7. **Verify** — curl the deployed endpoint, check the HTML contains the change
8. **Repeat** for `dockerfile-app` fixture

### 8.4 Success Criteria

- Extension auto-detects compose file vs. Dockerfile
- Git remote URL is read correctly
- Git repo is registered in Arcane (or existing one reused)
- GitOps sync is created and triggered
- Build succeeds on Arcane
- Container is running and serving HTTP
- HTML content matches the deployed version
- `arcane_status` returns correct running state
- `arcane_logs` returns nginx access logs

---

## Phase 9 — Nginx Routing for Deployed Containers

Arcane deploys containers on a Docker host (currently `starena`). Nginx on the host routes external traffic to the right container based on subdomain. The naming convention in the nginx config must match what the extension and Arcane produce.

### 9.1 Current routing pattern

Existing config at `/etc/nginx/sites-enabled/dynamic-tests.hajek.click`:

```nginx
resolver 172.17.0.1 valid=30s;

server {
    listen 8099;
    server_name ~^(?<t_name>t-[a-z0-9]+)\.hajek\.click$;

    location / {
        set $target_upstream http://$t_name:5553;
        proxy_pass $target_upstream;
        # ... headers, websocket support ...
    }
}
```

This routes `t-{containername}.hajek.click` → `http://{containername}:5553`. The `t-` prefix is preserved (used both in DNS and as the Docker container name).

### 9.2 What we need to add

A new vhost that matches our extension's deployment naming convention. Since the extension uses `{projectName}` (from repo name) and Arcane creates containers like `{projectName}_{serviceName}_{replica}`, we need a pattern that covers both single-container and compose deployments.

**Proposed naming convention** for the extension: `pi-{projectName}.hajek.click`

New nginx config `/etc/nginx/sites-enabled/pi-arcane.hajek.click`:

```nginx
resolver 172.17.0.1 valid=30s;

# pi-<projectname>.hajek.click — maps to project's primary web container
server {
    listen 8099;
    server_name ~^(?<pi_name>pi-[a-z0-9\-]+)\.hajek\.click$;

    location / {
        set $target_upstream http://$pi_name:5553;
        proxy_pass $target_upstream;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# pi-<projectname>-<service>.hajek.click — for compose multi-service
server {
    listen 8099;
    server_name ~^(?<pi_svc>pi-[a-z0-9\-]+\-[a-z0-9\-]+)\.hajek\.click$;

    location / {
        set $target_upstream http://$pi_svc:5553;
        proxy_pass $target_upstream;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Wait — the multi-service block would also match single-service names (since `pi-myapp-web` also matches `pi-[...]-[...]`). Nginx picks the first matching `server_name` by specificity, but these two regexes are ambiguous. Better to use a single block that handles both:

**Simplified single config:**

```nginx
resolver 172.17.0.1 valid=30s;

# pi-*.hajek.click — all pi-arcane deployments
server {
    listen 8099;
    server_name ~^(?<pi_name>pi-[a-z0-9\-]+)\.hajek\.click$;

    location / {
        set $target_upstream http://$pi_name:5553;
        proxy_pass $target_upstream;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### 9.3 How Arcane names containers

Arcane names containers based on the project and service. For a Compose project named `myapp` with service `web`:

```
{projectName}_{serviceName}_{replica}   e.g. myapp_web_1
```

For a single-container project named `myapp`:

```
{projectName}                           e.g. myapp
```

### 9.4 Container labeling for routing

The extension needs Arcane to label containers so they're reachable on the Docker network with a predictable name. Two approaches:

**Option A — Use Arcane's container name directly** (simplest):

- Let Arcane name the container naturally (e.g. `myapp_web_1`)
- Report the actual hostname back to the user after deploy
- User accesses `t-myapp_web_1.hajek.click` via the existing `dynamic-tests` nginx config
- No new nginx config needed at all!

**Option B — Add a `pi-` prefix via labels/network aliases**:

- Add a Docker network alias or label so the container is also reachable as `pi-myapp`
- New nginx vhost routes `pi-*.hajek.click`
- Cleaner URLs but requires container config changes

**Recommendation: Option A for now.** The existing `t-*.hajek.click` routing already works for any container name matching `t-[a-z0-9]+`. Arcane containers are on port 5553 by default. The extension just needs to:

1. Deploy the project/container via Arcane
2. Read back the container name from `GET /environments/{id}/containers`
3. Return the URL `https://t-{containername}.hajek.click` to the user

If the container name doesn't already have a `t-` prefix, the extension prepends it when constructing the URL.

### 9.5 Port mapping

**Default: every container gets port 5553 mapped to its internal port (80 by default).**

The extension auto-enforces this — not relying on any Arcane convention. How it works:

**For Compose projects** (via GitOps sync): The extension patches the compose YAML before sending it to Arcane. If the compose file doesn't have `ports:` on the first service, it adds `"5553:80"`. If it has ports but none on 5553, it appends the 5553 mapping. The original compose file in git is NOT modified — the patch happens in-memory when creating/updating the project.

**For single-container projects** (via `ContainerCreate`): The extension passes `hostConfig.portBindings: {"80/tcp": [{"hostPort": "5553"}]}` in the create request.

**Override via config** (`arcane.json`):

```json
{
  "defaults": {
    "portMapping": "8080:80"
  }
}
```

Or override per-deploy via the `arcane_deploy` tool's `port_mapping` parameter.

**Override via existing compose file**: If the repo's compose file already has explicit port mappings, the extension respects them (no patching). Only missing/missing-5553 gets patched.

### 9.6 DNS

Wildcard DNS for `*.hajek.click` must point to the nginx host. If not already configured:

```
*.hajek.click  A  <nginx-server-ip>
```

Or individual CNAMEs can be created per deployment, but wildcard is much simpler.

---

## Implementation Order

1. **Test fixtures** — `test-fixtures/compose-app/` and `test-fixtures/dockerfile-app/` (Phase 8)
2. **`types.ts`** — TypeBox schemas and TypeScript interfaces for all Arcane API models
3. **`config.ts`** — Config loader with env interpolation and resolution order
4. **`client.ts`** — `ArcaneClient` with all methods, error handling, response parsing
5. **`tools/list.ts`** — `arcane_list` (simplest, validates client+config)
6. **`tools/status.ts`** — `arcane_status`
7. **`tools/logs.ts`** — `arcane_logs`
8. **`tools/build.ts`** — `arcane_build`
9. **`tools/deploy.ts`** — `arcane_deploy` (the big one)
10. **E2E test** — Run test flow (Phase 8) against compose-app fixture
11. **E2E test** — Run test flow (Phase 8) against dockerfile-app fixture
12. **`commands/setup.ts`** — `/arcane-setup` wizard
13. **`commands/status.ts`** — `/arcane-status` dashboard
14. **`index.ts`** — Wire everything together, session_start restore state
