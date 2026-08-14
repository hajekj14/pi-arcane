# pi-arcane

A [pi](https://github.com/earendil-works/pi-mono) extension for end-to-end **develop → deploy**
workflows through [Arcane](https://arcane.hajek.click). Develop in pi, then ask pi to deploy — the
extension uploads the working tree to the Arcane host, builds it there, and reports where the result
is running.

**No git remote is involved.** Nothing is cloned, nothing has to be committed or pushed, and
uncommitted or untracked files deploy exactly as they sit on disk. Only files that changed since the
last deploy are re-uploaded.

Built against Arcane API 2.6.0 (`https://arcane.hajek.click/api/openapi.json`) and pi 0.84.1.

## Requirements

Deploys push through an **upload sidecar** running next to Arcane: a ~6 MB
`mayth/simple-upload-server` container that writes into a volume the Arcane container has mounted.
Arcane builds from a directory on its own filesystem, and this is what puts the tree there.

Deploy it once with [`upload-server/docker-compose.yml`](upload-server/docker-compose.yml), then
point `upload.url` at it. See [plan-upload.md](plan-upload.md) §7 for the full rationale, the nginx
body-size settings both proxy layers need, and how the shared-token auth is wired.

## Install

```bash
git clone git@github.com:hajekj14/pi-arcane.git
cd pi-arcane
npm install
```

Then either load it ad hoc:

```bash
pi -e /path/to/pi-arcane/extension
```

or add it permanently to `~/.pi/agent/settings.json`:

```json
{ "extensions": ["/path/to/pi-arcane/extension"] }
```

## Configure

Run `/arcane-setup` inside pi, or write the config by hand. Resolution order (first match wins):

1. `.pi/arcane.json` (project-local)
2. `arcane.json` (project root)
3. `~/.pi/agent/arcane.json` (global)

Minimal config:

```json
{
  "apiKey": "$ARCANE_API_KEY",
  "upload": { "url": "https://pump.hajek.click" }
}
```

Full config:

```json
{
  "host": "https://arcane.hajek.click",
  "apiKey": "$ARCANE_API_KEY",
  "environmentId": "0",
  "upload": {
    "url": "https://pump.hajek.click",
    "token": "$ARCANE_API_KEY",
    "containerPath": "/app/data/pi-arcane",
    "volumeName": "arcane_arcane-data",
    "maxFileBytes": 268435456
  },
  "defaults": {
    "composePath": "docker-compose.yml",
    "targetType": "compose",
    "projectName": "my-app",
    "portMapping": "5553:80"
  }
}
```

- `apiKey` accepts a literal, `$ENV_VAR` / `${ENV_VAR}`, or `!command` (`$$` escapes `$`, `$!`
  escapes a leading `!`) — the same semantics as a pi provider key.
- `environmentId` is optional. When absent, the extension calls `GET /environments`, auto-selects a
  lone environment or prompts, and writes the choice back so later sessions skip the prompt.
- `upload.url` is **required for deploys**; everything else under `upload` has a working default:
  - `token` defaults to the Arcane API key, because the sidecar is deployed with that same
    credential. Accepts the same `$ENV_VAR` / `!command` forms.
  - `containerPath` is where uploads appear *inside the Arcane container* — the path a build's
    `contextDir` uses. Defaults to `/app/data/pi-arcane`.
  - `volumeName` is only needed if the volume backing `containerPath` cannot be discovered from the
    Arcane container's mounts. It is used to delete files that leave the working tree; the sidecar
    has no DELETE.
  - `maxFileBytes` must not exceed `-max_upload_size` in the sidecar or `client_max_body_size` in
    either nginx layer. Defaults to 256 MiB.
- Everything in `defaults` is optional; set a field only to force a value that should never be
  auto-detected.

`arcane.json` is gitignored — it can hold a key.

## What gets uploaded

Inside a git repository: `git ls-files -co --exclude-standard`, i.e. every tracked file plus every
untracked file that is not ignored, minus deletions. `.gitignore` is therefore honoured for free, and
uncommitted work is included — that is the point. Outside a repository, the directory is walked with
a built-in ignore list (`.git`, `node_modules`, `dist`, `.venv`, …).

`.dockerignore` is applied on top, so anything the build would ignore is never sent.

The upload root is the **working directory**, not the repository root, so a monorepo deploys one app
at a time. Uploads land in `<containerPath>/<slug>/ctx`, where the slug combines the directory name
with a hash of its absolute path — two checkouts of the same project never collide.

Change detection is by SHA-256, recorded in a manifest stored beside the context (never inside it, so
it cannot perturb BuildKit's cache key). The manifest is written **last**, so an interrupted upload
re-uploads next time rather than silently under-uploading.

## Tools

| Tool | What it does |
| --- | --- |
| `arcane_deploy` | Upload the working tree and run it. Detects compose vs. Dockerfile, builds, deploys, and reports URLs. |
| `arcane_status` | Projects and containers, with a filter. |
| `arcane_build` | Upload and build an image on the Arcane host without deploying it. |
| `arcane_logs` | Read container or project logs. |
| `arcane_list` | List projects, uploaded build contexts, containers or environments. |
| `arcane_destroy` | Tear down a project, its containers and its uploaded build context. Volumes kept unless asked. |

## Commands

- `/arcane-setup` — wizard: host, API key, environment, upload sidecar, write config.
  `/arcane-setup test` also runs a connection check.
- `/arcane-status` — dashboard of environment status, projects, uploaded contexts and running
  containers, rendered into the transcript.
- `/arcane-destroy [project]` — pick a project and tear it down. Prompts before deleting volumes.

## How a deploy works

1. Collect the files (above) from the working directory.
2. Diff them against the manifest of the previous upload; PUT what changed to the sidecar, 8 at a
   time. Files that left the tree are deleted through Arcane's volume API.
3. Then, depending on the shape:

**Compose projects** (a `compose.yaml` / `docker-compose.yml` exists): Arcane gets a copy of the
compose file with every service's `build.context` rewritten to the uploaded path, so `up` builds from
the uploaded tree. Absolute contexts and services without `build:` are left alone.

**Dockerfile-only projects**: the image is built from the uploaded context
(`POST /images/build` with `contextDir` pointing at it) and run as a generated one-service compose
project.

4. Poll the resulting activity, then report project status, containers and URLs.

**Your local files are never modified**, and neither is the compose file in your repository — the
rewrite applies only to the copy Arcane holds.

## Ports and public URLs

Deployments are reached at **`https://pi-<hostPort>.hajek.click`**, e.g. `https://pi-5553.hajek.click`.

This needs the vhost in [`nginx/pi-arcane.conf`](nginx/pi-arcane.conf) installed on the Docker host
**once**; after that every future deployment works with no further nginx change.

### Why the hostname encodes a port

The obvious design — `pi-<appname>.hajek.click` proxying to a container by name — does not work on
this host, and it fails in a way that looks like the app is broken:

- Host nginx cannot resolve Docker container names. Each deployment lands on its own compose network
  and Docker's embedded DNS is not reachable from the host, so `resolver 172.17.0.1` never answers.
- The request then 502s after a ~30s DNS timeout — identical behaviour whether the container exists
  or not, which makes it look like a deploy failure rather than a routing one.

Encoding the published host port sidesteps DNS entirely and uses the same `127.0.0.1:<port>` upstream
the host's other working vhosts already use.

### What the extension does

- Publishes each deployment on a **free host port**, starting at 5553 and scanning upward (5554,
  5555, …) so a second app does not fail with *"port is already allocated"*. A project keeps its port
  across redeploys.
- Adds `<port>:80` to the compose file **only if the primary service publishes nothing**. A compose
  file that publishes its own ports is being deliberate, and overriding it would break the
  deployment the repo asked for — the extension reports what is actually published instead.
- Reports a URL only for ports that are genuinely published; it never prints a plausible-looking URL
  that would fail.

The patch applies to Arcane's copy — **your compose file is untouched** — and is re-applied on every
deploy.

Override with the `port_mapping` tool argument or `defaults.portMapping`. Ports outside 5550–5599 are
rejected by the vhost's guard (which stops a crafted hostname reaching, say, Arcane's own port) —
widen the range in the config if you need one.

## Container logs

Arcane exposes logs only over WebSocket
(`/api/environments/{id}/ws/containers/{id}/logs`) — there is no REST equivalent. The browser
`WebSocket` API cannot set the `X-API-Key` header, so `extension/ws.ts` is a small RFC 6455 client
that does the handshake over `node:https` and frames the connection by hand. It is covered by
`scripts/ws-test.ts`.

## Development

```bash
npm run typecheck    # tsc --noEmit over extension/ and scripts/
npm run test:smoke   # loads the extension against a stub host; unit-tests the pure logic
npm run test:ws      # RFC 6455 client against a local server
npm test             # all three
```

The pi packages are devDependencies pinned to the pi version this was built against (0.84.1); at
runtime pi provides them.

## End-to-end test

`test-fixtures/compose-app` and `test-fixtures/dockerfile-app` are two minimal nginx apps that serve
a static page. The harness drives the real tools — the same code path the model uses — and then
verifies over HTTP that the deployed page serves what is on disk.

Prerequisites:

- `ARCANE_API_KEY` exported (or an `arcane.json` in one of the config locations).
- `upload.url` configured, and the sidecar running. Each fixture has its own
  `.pi/arcane.json` (gitignored), which must carry it too, since the fixture directory is the cwd.
- [`nginx/pi-arcane.conf`](nginx/pi-arcane.conf) installed on the Docker host, for the URL check.
- No git remote, push, or repository scope is needed.

```bash
export ARCANE_API_KEY=...
npm run e2e              # both fixtures
npm run e2e -- compose   # just one
```

Per fixture the harness:

1. writes an **untracked** `www/uncommitted-marker.html` that exists nowhere in git,
2. deploys, reads back the host port the project actually got, and polls
   `https://pi-<port>.hajek.click` for the `<h1>` of `index.html`,
3. polls the marker's URL — serving it is what proves the deploy came from the working tree rather
   than a clone,
4. deploys a second time and asserts the upload was incremental (0 files sent, all unchanged),
5. exercises `arcane_status` and `arcane_logs`, and deletes the marker again.

It exits non-zero if any check fails.

To test the full develop → deploy loop by hand — note there is nothing to commit:

```bash
cd test-fixtures/compose-app
pi -e ../../extension
> change "Works!" to "Works! v2" in www/index.html, then deploy it to Arcane
> curl the URL and check it says v2
```
