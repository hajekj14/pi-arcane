# pi-arcane

A [pi](https://github.com/earendil-works/pi-mono) extension for end-to-end **develop → deploy**
workflows through [Arcane](https://arcane.hajek.click). Develop in pi, commit, push, then ask pi to
deploy — the extension registers the repo with Arcane, drives a GitOps sync or an image build, and
reports where the result is running.

Built against Arcane API 2.6.0 (`https://arcane.hajek.click/api/openapi.json`) and pi 0.84.1.

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
{ "apiKey": "$ARCANE_API_KEY" }
```

If no config file exists anywhere, a bare `ARCANE_API_KEY` environment variable is enough.

Full config:

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
    "syncName": "my-app-staging",
    "portMapping": "5553:80"
  }
}
```

- `apiKey` accepts a literal, `$ENV_VAR` / `${ENV_VAR}`, or `!command` (`$$` escapes `$`, `$!`
  escapes a leading `!`) — the same semantics as a pi provider key.
- `environmentId` is optional. When absent, the extension calls `GET /environments`, auto-selects a
  lone environment or prompts, and writes the choice back so later sessions skip the prompt.
- Everything in `defaults` is optional; set a field only to force a value that should never be
  auto-detected.

`arcane.json` is gitignored — it can hold a key.

### Git credentials

Arcane clones from the git remote, so it needs access. The extension looks for a token in
`ARCANE_GIT_TOKEN`, `GIT_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, `CI_JOB_TOKEN`, in that
order, and prompts interactively as a fallback. A public repo needs none. SSH remotes are converted
to HTTPS, since that is what Arcane clones with. Tokens are stored in Arcane's git-repository record,
never written to disk by this extension, and redacted from all output.

## Tools

| Tool | What it does |
| --- | --- |
| `arcane_deploy` | Deploy the current repo. Detects compose vs. Dockerfile, registers the repo, creates/updates a GitOps sync or builds an image, deploys, and reports URLs. |
| `arcane_status` | Projects, GitOps syncs and containers, with filters. |
| `arcane_build` | Build an image on the Arcane host without deploying it. |
| `arcane_logs` | Read container or project logs. |
| `arcane_list` | List projects, syncs, containers, git repositories or environments. |

## Commands

- `/arcane-setup` — wizard: host, API key, environment, write config. `/arcane-setup test` also runs
  a connection check.
- `/arcane-status` — dashboard of projects, syncs and running containers, rendered into the
  transcript.

## How a deploy works

**Compose repos** (a `compose.yaml` / `docker-compose.yml` exists):

1. Read the git remote, branch and HEAD from the local checkout.
2. Refuse to deploy if the branch is not on `origin`; warn if the working tree is dirty or local is
   ahead of the remote. Arcane deploys the *pushed* commit.
3. Register (or reuse) the repository in Arcane, refreshing credentials.
4. Create or update a GitOps sync pointing at repo + branch + compose path.
5. Trigger the sync — Arcane clones and applies the compose file.
6. Patch Arcane's copy of the compose file if needed (see below), then bring the project up.
7. Poll the resulting activity, then report project status, containers and URLs.

**Dockerfile-only repos**: Arcane's project model is compose-based and a GitOps sync requires a
compose file that exists in the repo, so instead the image is built from the git remote
(`POST /images/build` with a BuildKit git context) and run as a generated one-service compose
project. **Your repository is never modified.**

## Ports, container names and public URLs

The Docker host serves deployments through an existing nginx vhost:

```nginx
server_name ~^(?<t_name>t-[a-z0-9]+)\.hajek\.click$;
set $target_upstream http://$t_name:5553;
```

Two consequences drive the extension's behaviour, and they are easy to get wrong:

- **The container must publish host port 5553**, because that is where nginx proxies.
- **The container must be named exactly `t-<lowercase alphanumerics>`**, because nginx proxies to
  that literal name. Compose's generated names (`compose-app-web-1`) do **not** match the pattern —
  it allows no dashes after the prefix — and prepending `t-` to them yields a hostname Docker cannot
  resolve. So a naive compose deployment runs fine but is unreachable.

The extension therefore patches the compose document it hands to Arcane, filling in **only what is
absent**:

- adds `5553:80` if the primary service publishes nothing;
- pins `container_name: t-<project>` if the service does not name itself.

A compose file that sets its own ports or container name is left alone — that configuration is
deliberate, and overriding it would break the deployment the repo asked for. In that case the
extension reports what is actually published and, when the name cannot be routed, says so instead of
printing a URL that would 502.

The patch applies to Arcane's copy; **the file in git is untouched**. With `autoSync` off (the
default) it is re-applied on every deploy. With `autoSync` on, Arcane's next poll overwrites it — the
extension warns, and the fix is to commit the ports and `container_name` into the compose file.

Override the mapping per-deploy with `port_mapping`, or globally via `defaults.portMapping`.

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
verifies over HTTP that the deployed page serves what is in git.

Prerequisites:

- `ARCANE_API_KEY` exported.
- The branch under test pushed to `origin` (Arcane clones from the remote, not your working tree).
- `GITHUB_TOKEN` exported if this repository is private.
- Wildcard DNS `*.hajek.click` pointing at the nginx host, and the existing `t-*` vhost in place.

```bash
export ARCANE_API_KEY=...
git push origin main
npm run e2e              # both fixtures
npm run e2e -- compose   # just one
```

The harness deploys each fixture, polls `https://t-composeapp.hajek.click` /
`https://t-dockerfileapp.hajek.click` until the page contains the `<h1>` text from the committed
`index.html`, then exercises `arcane_status` and `arcane_logs`. It exits non-zero if any check fails.

To test the full develop → deploy loop by hand:

```bash
cd test-fixtures/compose-app
pi -e ../../extension
> change "Works!" to "Works! v2" in www/index.html, commit and push, then deploy it to Arcane
> curl the URL and check it says v2
```
