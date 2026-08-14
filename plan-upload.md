# Direct Repository Upload → Build — Implementation Plan

> **Status: implemented and shipped.** Upload is now the *only* deploy path — the git-remote /
> GitOps route was removed entirely (`extension/repo.ts` deleted, git-repository and GitOps-sync
> clients dropped, `arcane_build` and `arcane_deploy` rewritten around `extension/upload.ts`). The
> `source: "git" | "upload" | "auto"` switch described in §3.6 was therefore never built: there is
> nothing to switch between. Verified end to end against both fixtures — 12/12 checks, including
> serving an untracked file that exists nowhere in git.

## Verdict

**Yes, it is possible today** — without any change to Arcane — but not through a purpose-built
"upload a repo" endpoint. Arcane has no archive-upload or server-side extract API. What it does have
is a per-file upload API into a Docker volume, plus a build endpoint whose `contextDir` accepts an
**absolute path inside the Arcane server container**. Uploading the working tree file-by-file into
the Arcane data volume and pointing the build at it works end to end — verified live against
`arcane.hajek.click` (env `0`) on 2026-08-14 while writing this plan.

This removes the current hard requirement in [build.ts](extension/tools/build.ts) that the branch be
**committed and pushed** before it can be built: `arcane_build` today constructs a git context
(`https://…git#branch`) via `buildKitContext()` in [repo.ts:221](extension/repo.ts#L221). Upload mode
builds whatever is on disk, including uncommitted changes.

---

## 1. What the API actually offers

Checked against `https://arcane.hajek.click/api/openapi.json` (Arcane API 2.6.0, 251 paths). Nothing
matches `archive`, `extract`, `unpack`, `untar`, or `decompress` anywhere in the spec.

### 1.1 The build endpoint

`POST /environments/{id}/images/build` — body `DockerTypesBuildRequest`, only `contextDir` required.

`contextDir` is documented as "Build context directory or Git URL" and is resolved as follows
(observed):

| `contextDir` value | Behaviour |
| --- | --- |
| `https://…` / `git@…` | Treated as a **git remote**. Logged: `resolving remote git context`, then `verifying remote git repository`. A plain `https://host/ctx.tar.gz` is *not* fetched as a tarball — it is probed with `git ls-remote` and fails. |
| absolute filesystem path | `stat`-ed **inside the Arcane server container**. Missing path → `build context not found: stat /does-not-exist-probe: no such file or directory`. Existing dir → Arcane packs it and hands it to BuildKit (`#1 [internal] load remote build context`, `#2 copy /context /`). |

So: **a BuildKit tarball-URL context is not available; a server-local directory is.** The job is
getting the repo into a directory the Arcane container can see.

### 1.2 The two file-upload surfaces

| Surface | Endpoints | Status on this deployment |
| --- | --- | --- |
| **Builds workspace** (the intended one) | `GET/DELETE /environments/{id}/builds/browse`, `POST …/browse/upload`, `POST …/browse/mkdir`, `GET …/browse/content`, `GET …/browse/download` | **Broken** — every call returns `500 failed to ensure builds directory: mkdir /builds: permission denied`. The Arcane container has no `/builds` mount and cannot create one. |
| **Volume browse** | `GET/DELETE /environments/{id}/volumes/{volumeName}/browse`, `POST …/browse/upload`, `POST …/browse/mkdir`, `GET …/browse/content`, `GET …/browse/download` | **Works.** Verified upload + mkdir + list + delete. |

The volume route works for builds because of how the Arcane container is mounted:

```
/var/run/docker.sock                      → /var/run/docker.sock      (bind)
volume arcane_arcane-data                 → /app/data                 (rw)
/home/hajekj/projects                     → /app/data/projects        (bind)
```

Volume `arcane_arcane-data` is mounted at `/app/data`, so a file uploaded to volume path
`/pi-arcane/foo/ctx/Dockerfile` is visible to the build as `/app/data/pi-arcane/foo/ctx/Dockerfile`.
That is the whole trick.

### 1.3 Live proof

```
POST /environments/0/volumes/arcane_arcane-data/browse/mkdir?path=/pi-upload-probe    → 204
POST /environments/0/volumes/arcane_arcane-data/browse/upload?path=/pi-upload-probe   → 204  (Dockerfile)
POST /environments/0/volumes/arcane_arcane-data/browse/upload?path=/pi-upload-probe   → 204  (hello.txt)
POST /environments/0/images/build  {"contextDir":"/app/data/pi-upload-probe", …}
     #1 [internal] load remote build context  DONE
     #2 copy /context /                       DONE
     #5 [2/2] COPY hello.txt …                DONE
     #6 exporting to image … naming to docker.io/library/pi-upload-probe:test  DONE
     {"done":true}
```

All probe artifacts were deleted afterwards (volume dir removed, `pi-upload-probe:test` image
removed; both confirmed gone).

---

## 2. Constraints found by probing

These drive the design and are not in the docs.

1. **~1 MiB request-body cap.** The nginx in front of Arcane (`nginx/1.18.0 (Ubuntu)`) returns
   `413 Request Entity Too Large`. Measured: 1,000,000 B → `204`; 2,000,000 B and 8,000,000 B →
   `413`. This is the stock `client_max_body_size 1m`. **Per-file limit, and there is no server-side
   extract, so a single repo tarball is not an option.**
2. **No recursive create.** Uploading to a path whose parent does not exist fails with
   `500 … Could not find the file /volume/pi-upload-probe/sub/deep in container …`. Every directory
   must be `mkdir`-ed explicitly, parents first.
3. **Upload is implemented as `docker cp` into a helper container** (the error above leaks
   `/volume/…` and a container ID). Cost per file ≈ **0.65 s** sequential. Concurrency helps:
   6 parallel uploads completed in **1.57 s** wall (~4 files/s). Plan for a bounded pool.
4. **Path traversal is contained.** `path=/../etc` resolved to `/volume/etc` inside the helper —
   no escape from the volume, but also no way to reach outside `/app/data`.
5. **`modTime` on uploaded files is `1970-01-01T00:00:00Z`.** `docker cp` zeroes it, so directory
   listings cannot be used for change detection. Size is preserved and correct.
6. **Local environment only.** `/app/data` is the Arcane server's own volume. For an edge/remote
   environment the build runs on a different host, where that path does not exist. Upload mode must
   refuse (or fall back to git mode) on non-local environments.
7. **One transient build failure observed**: a first build of `FROM alpine:3.20` from an uploaded
   context died at `#3 [internal] load metadata … ERROR: no active sessions`; an immediate rebuild of
   the same context with `FROM nginx:alpine` succeeded, and a git-context control build resolved
   metadata fine. Treat `no active sessions` as a retryable BuildKit hiccup (one automatic retry),
   not as a defect in upload mode.

---

## 3. Design

### 3.1 Server-side layout

```
volume arcane_arcane-data                     (container path /app/data)
└── pi-arcane/
    └── <slug>/                               slug = sanitized repo name + short hash of repo root path
        ├── manifest.json                     { version, files: { "<relpath>": { size, sha256 } } }
        └── ctx/                              ← contextDir = /app/data/pi-arcane/<slug>/ctx
            ├── Dockerfile
            └── …repo files…
```

The manifest lives **outside** `ctx/` so it never lands in the build context and never perturbs the
BuildKit cache key.

### 3.2 Target resolution (never hardcode `/app/data`)

`resolveUploadTarget(client, envId)` in a new `extension/upload.ts`:

1. Probe `GET /environments/{id}/builds/browse?path=/`.
   - `200` → use the **builds workspace** surface (`/builds/browse/*`), context prefix `/builds`.
     Preferred: it is the intended API and does not touch Arcane's data volume. Its absolute prefix
     must be re-verified with one throwaway build the first time a deployment has it mounted (see
     §6 open question).
   - `500 … mkdir /builds: permission denied` → fall through.
2. `GET /environments/{id}/containers`, find the container whose image matches
   `^(ghcr\.io/getarcaneapp/)?arcane`, read its `mounts`, and pick the entry with
   `type === "volume"` whose `destination` is a prefix of the others (`/app/data` here). That yields
   `{ volumeName, containerPath }`.
3. Verify `GET /environments/{id}/volumes/{volumeName}/browse?path=/` returns `200`.
4. Cache the result on the runtime for the session.

Failing all of that, upload mode reports why and points at git mode.

### 3.3 File selection

Run in the repo root, in this order:

1. `git ls-files -co --exclude-standard -z` — tracked **plus** untracked-but-not-ignored files. This
   is the point of upload mode: uncommitted work is included, `.gitignore` is respected for free.
   Outside a git repo, fall back to a directory walk with a built-in ignore list (`node_modules`,
   `.git`, `dist`, …).
2. Drop deleted-but-tracked paths (`git ls-files -d`).
3. Apply `.dockerignore` from the context subdir if present, using the same matcher BuildKit uses
   (leading `!` re-includes; `**` globs). Reduces both upload volume and cache churn.
4. Restrict to the `context_dir` subtree and rebase paths onto it.
5. Reject up front, with the offending list, if any file exceeds the body cap (default 1 MiB, with a
   `uploadMaxBytes` config override for operators who raised `client_max_body_size`). Also refuse a
   total >200 MB or >5,000 files without an explicit `force`, to avoid a 20-minute silent upload.
6. Symlinks: resolve within the repo, skip (with a warning) any that escape it.

### 3.4 Incremental sync

Full upload of a mid-size repo is ~1–2 minutes; repeated builds should be seconds.

1. Compute `sha256` + size for every selected file locally.
2. `GET …/browse/content?path=/pi-arcane/<slug>/manifest.json` (base64/text payload) for the
   previous manifest. Missing/unparsable → treat as empty.
3. Diff:
   - **changed/new** → upload;
   - **removed** → `DELETE …/browse?path=…`;
   - **unchanged** → skip.
4. `mkdir` every directory in the new set that is not already present, parents first (dedupe and
   sort by depth — one call per directory, not per file).
5. Upload changed files with a **concurrency of 6** and a small retry (2 attempts, 500 ms backoff)
   on `5xx`, since the helper-container path is occasionally flaky.
6. Write the new `manifest.json` last, so an interrupted upload leaves a stale-but-conservative
   manifest and the next run re-uploads rather than under-uploading. Include the manifest's own
   `version` so a format change forces a full resync.
7. `--no-cache`-style escape hatch: `refresh: true` deletes `ctx/` and re-uploads everything.

### 3.5 Client additions ([client.ts](extension/client.ts))

The existing `request()` always JSON-encodes the body, so multipart needs a sibling. Add a private
`requestMultipart(method, path, { query, file: { name, bytes }, signal, timeoutMs })` that builds a
`FormData` with a `Blob` under the field name `file` and lets `fetch` set the boundary — the same
error unwrapping (`ArcaneApiError`, `{success,data}` envelope) otherwise.

Public methods, all mirroring the two surfaces behind one `FileSurface` type
(`{ browse, upload, mkdir, remove, content }`) so builds-workspace and volume paths are
interchangeable:

```ts
browseVolume(envId, volume, path, signal): Promise<VolumeFileEntry[]>
uploadVolumeFile(envId, volume, dirPath, fileName, bytes, signal): Promise<void>   // 204
mkdirVolume(envId, volume, path, signal): Promise<void>                            // 204
deleteVolumePath(envId, volume, path, signal): Promise<void>                       // 204
readVolumeFile(envId, volume, path, maxBytes?, signal): Promise<BuildFileContentResponse>
browseBuilds / uploadBuildsFile / mkdirBuilds / deleteBuildsPath / readBuildsFile  // same shapes
```

Types go in [types.ts](extension/types.ts): `VolumeFileEntry`, `BuildFileContentResponse`,
`UploadTarget`, `UploadManifest`, `UploadResult`.

### 3.6 Tool surface

Add `source` to `arcane_build` ([tools/build.ts](extension/tools/build.ts)) and `arcane_deploy`
([tools/deploy.ts](extension/tools/deploy.ts)):

```
source: "git" | "upload" | "auto"     (default "auto")
```

- `"git"` — today's behaviour, unchanged.
- `"upload"` — upload the working tree and build from it. No push required; no git remote required.
- `"auto"` — `upload` when the working tree is dirty or the branch has unpushed commits **and** the
  environment is local **and** an upload target resolves; otherwise `git`. The chosen mode and the
  reason are stated in the tool output, so the model never has to guess what got built.

Related params: `refresh` (force full re-upload), `include_untracked` (default `true`),
`upload_only` (upload and report the path without building — useful for debugging).

`arcane_deploy` in upload mode: build the image from the uploaded context, then deploy the resulting
tag exactly as it does today for the Dockerfile path. Compose projects that reference `build:` are
out of scope for the first cut — Arcane's project/compose flow expects a git-backed sync — so
upload mode applies to the image-build path only, and `arcane_deploy` says so when it declines.

Cleanup: `arcane_destroy` ([tools/destroy.ts](extension/tools/destroy.ts)) should delete
`/pi-arcane/<slug>` alongside the other resources it tears down. Add a `stale contexts` line to
`arcane_list` so orphans are visible.

### 3.7 Output

```
Uploaded 34 files (1.2 MB, 118 skipped unchanged) to /app/data/pi-arcane/pi-arcane-8f3a1c/ctx in 7.8s
Building myapp:main from uploaded working tree (dirty: 3 modified, 1 untracked)...
Image build finished.
  tags=myapp:main  context=upload:/app/data/pi-arcane/pi-arcane-8f3a1c/ctx  dockerfile=Dockerfile
  status=success  buildId=…  digest=sha256:…  duration=12s
```

Progress goes through `onUpdate` during the upload phase (files done / total), since a cold upload
can run over a minute.

---

## 4. Phases

| # | Work | Est. |
| --- | --- | --- |
| **1** | `requestMultipart` + the ten browse/upload/mkdir/delete/content client methods + types. Unit-level: hit a scratch volume dir directly. | 0.5 d |
| **2** | `extension/upload.ts`: `resolveUploadTarget`, `collectFiles` (git ls-files + .dockerignore + limits), `hashFiles`, `syncContext` (manifest diff, mkdir, bounded-concurrency upload, delete, manifest write), `cleanupContext`. | 1 d |
| **3** | Wire `source` into `arcane_build`, including `auto` detection (`git status --porcelain`, `git rev-list @{u}..` for unpushed) and the one-shot retry on `no active sessions`. | 0.5 d |
| **4** | Wire `source` into `arcane_deploy` (image path only) + `arcane_destroy` cleanup + `arcane_list` orphan reporting. | 0.5 d |
| **5** | Tests: extend [scripts/e2e.ts](scripts/e2e.ts) with an upload-mode build of `test-fixtures/dockerfile-app` **with a locally-modified, uncommitted file**, asserting the change is present in the built image; a 413 case (>1 MiB file → clear error); an incremental case (second run uploads only the changed file); teardown asserting `/pi-arcane/<slug>` is gone. Add a `builds`-workspace-unavailable path to [scripts/smoke.ts](scripts/smoke.ts). | 0.5 d |
| **6** | README section: upload vs git mode, the 1 MiB cap and how to raise it, local-environment-only limitation. | 0.25 d |

### Operator-side follow-up (not extension work, recommended)

Both fixes are on the Arcane host, which you control:

1. **Raise the proxy body cap** — `client_max_body_size 64m;` in the nginx server block for
   `arcane.hajek.click`. Removes the per-file 1 MiB ceiling, which is the single most likely cause
   of a confusing failure.
2. **Mount a builds workspace** — add a volume at `/builds` (writable by Arcane's UID) to the Arcane
   compose service. That makes the first-class `builds/browse/*` API work, avoids writing into
   Arcane's own data volume, and is probably a direct-filesystem path rather than the
   `docker cp`-per-file helper, i.e. much faster. Once mounted, phase 2's probe picks it
   automatically.

---

## 5. Risks

| Risk | Mitigation |
| --- | --- |
| Writing build contexts into Arcane's **data volume** (next to `arcane.db`) | Everything confined to `/pi-arcane/<slug>/`; `arcane_destroy` cleans it; prefer the builds workspace whenever it resolves. |
| 1 MiB per-file cap breaks real repos (any bundled binary, image, lockfile snapshot) | Pre-flight check names the offending files and prints the nginx fix; `.dockerignore` usually excludes them anyway. |
| Slow first upload on large repos | Bounded concurrency, manifest-based incrementals, hard limits with an explicit override, live progress. |
| Upload interrupted mid-way → half-written context builds silently | Manifest written last; interrupted state is conservative (re-upload), never a false "unchanged". |
| Arcane changes its mount layout or the volume-browse endpoints | Target resolution is discovered at runtime, not hardcoded; a clear error tells the user to use `source: "git"`. |
| Non-local / edge environments | Detected via `GET /environments`; upload mode refuses with an explanation and `auto` silently picks git. |
| Stale contexts accumulating | `arcane_list` reports them; `arcane_destroy` removes them. |

---

## 6. Open questions

1. **Builds-workspace absolute prefix.** When `/builds` is mounted, is the browse root exactly
   `/builds` (so `contextDir = /builds/pi-arcane/<slug>/ctx`)? The error message strongly implies it,
   but it cannot be confirmed until a deployment has the mount. Verify with one throwaway build
   before trusting it; keep the volume fallback either way.
2. ~~**Compose projects.**~~ **Resolved — compose upload mode works.** A project whose compose sets
   `build: { context: /app/data/pi-arcane/<slug>/ctx, dockerfile: Dockerfile }` builds straight from
   the uploaded tree on `up`; Arcane tags the result `arcane.local/<project>-<id>/web:latest` and
   deploys it. Verified with `test-fixtures/compose-app` at `https://pi-5561.hajek.click`. So §3.6's
   "image builds only" restriction can be lifted: `arcane_deploy` in upload mode rewrites each
   service's `build.context` to the uploaded path and otherwise leaves the compose file alone.
   Services with no `build:` key are untouched.
3. **Registry push.** Upload mode composes fine with `push: true`, but registry credentials on the
   Arcane side were not exercised in this investigation.

---

## 7. Upload sidecar (preferred transport)

Limitations 1 and 2 in §2 — the 1 MiB cap and the 0.65 s-per-file `docker cp` helper — are both
properties of *Arcane's* upload endpoint, not of the approach. Deploying a small upload server that
mounts the same volume removes both, because the extension then talks to it directly and Arcane only
ever reads the resulting directory.

### 7.1 The image

**`mayth/simple-upload-server:v2`** — [github.com/mayth/go-simple-upload-server](https://github.com/mayth/go-simple-upload-server)

| | |
| --- | --- |
| Size / base | ~6 MB compressed, `gcr.io/distroless/static-debian13` (no shell, no package manager) |
| Language | Go, single static binary, MIT, 239★, last release 2026-07-10 |
| Secret | exactly one bearer token — **the Arcane API key itself**, so the extension carries one credential for both services |
| Config | CLI flags or a JSON config file — no user database, no init step |
| Upload | `PUT /files/<any/nested/path>` (multipart, field `file`) and `POST /upload` |
| Directories | `MkdirAll(dir, 0755)` before writing — nested paths just work ([server.go:274](https://github.com/mayth/go-simple-upload-server/blob/v2/pkg/server.go#L274)) |
| Sandboxing | `afero.NewBasePathFs(osFs, document_root)` — paths cannot escape the document root |
| Size limit | `-max_upload_size`, **default 1 MiB — must be raised** |

Two behaviours the client must respect:

- **Overwrite is opt-in.** A second `PUT` to an existing path returns `409 Conflict` unless
  `?overwrite=true` is set. Always set it.
- **No `DELETE`.** Removing files that disappeared from the working tree still goes through Arcane's
  `DELETE /environments/{id}/volumes/{volumeName}/browse?path=…`, which works on any volume. Deletes
  are rare, so the slow path is fine there.

Rejected alternatives: WebDAV images (`ugeek/webdav`, `maltokyo/docker-nginx-webdav`) give native
`DELETE`/`MKCOL` but are nginx+htpasswd stacks needing a username *and* password, and the popular
ones were last built in 2022; `filebrowser` and `sftpgo` need an admin account and initial setup;
`crycode/http-server-upload` is Node (~150 MB) and uploads flat into one directory.

### 7.2 Deployment

Deployed as its own Arcane compose project: [upload-server/docker-compose.yml](upload-server/docker-compose.yml)
(project `pi-arcane-upload`, id `c9a83ea3-2491-426c-9e8e-af6d3cfd4eb7`). It mounts the existing
external volume `arcane_arcane-data` and sets `document_root: /data/pi-arcane`, so the server can only
touch `pi-arcane/` even though the volume holds `arcane.db`.

**Auth is the Arcane API key**, one credential for both services. Because that key is an admin
credential, it is *not* passed as a CLI flag or an env var — either would expose it in
`docker inspect`, in Arcane's container-details view, and in `ps` on the host. Instead the container
runs `-config /config/pi-arcane-upload.config.json`, reading a JSON file that sits at
`/app/data/pi-arcane-upload.config.json` in the volume, deliberately **outside** `document_root` so it
is not readable over HTTP. Verified after deployment: the container's `cmd` is
`["-config","/config/pi-arcane-upload.config.json"]`, its env is just `PATH` and `SSL_CERT_FILE`, and
the key appears nowhere in the container metadata. The compose file itself contains no secret.

Consequence to remember: rotating the Arcane API key now also requires rewriting that config file and
restarting the container.

Published on host port **5559**. The wildcard vhost ([nginx/pi-arcane.conf](nginx/pi-arcane.conf)
covers 5550-5599) already routes it as `https://pi-5559.hajek.click`; the intended public name is
`https://pump.hajek.click` via [nginx/pump.hajek.click.conf](nginx/pump.hajek.click.conf), which adds
upstream keepalive, `proxy_request_buffering off`, and the raised body limit.

**Both** nginx layers needed `client_max_body_size 256m` — the docker-host vhost and, more
importantly, the TLS-terminating front VM, whose `*.hajek.click` catch-all set no limit and so
inherited the stock 1 MB default. Since raising it in the catch-all would lift the cap for every
subdomain, pump gets its own exact-match block
([nginx/front-vm-pump.hajek.click.conf](nginx/front-vm-pump.hajek.click.conf)); nginx prefers an exact
`server_name` over a wildcard.

Diagnosing which layer rejects: check `curl -w %{size_upload}`. Zero bytes sent means the *first*
hop rejected on `Content-Length` before reading a body; a full body sent before the 413 means the
front VM accepted it, buffered it, and the rejection came from behind.

A second, unrelated cap surfaced once nginx was fixed: uploads died with a 500 at ~35.7 MB, logging
`open /tmp/multipart-...: read-only file system`. Go's multipart parser holds 32 MiB in memory and
spills the rest to `os.TempDir()`, which `read_only: true` blocks. Fixed with a bounded
`tmpfs: /tmp:size=512m,mode=1777` — files under 32 MiB never touch it, and the cap means a runaway
upload fails with ENOSPC rather than eating host RAM.

Verified after both fixes: 5 MB, 20 MB and 100 MB all `201`; 300 MB `413` at 0 bytes sent, i.e.
rejected cleanly by nginx rather than half-written. Sustained throughput was ~1.1 MB/s, which is the
dev machine's uplink, not the server — another reason the per-file incremental sync in §3.4 matters
more than raw single-file speed.

### 7.3 Path mapping

```
PUT https://pi-5559.hajek.click/files/<slug>/ctx/src/index.ts?overwrite=true
  → sidecar writes /data/pi-arcane/<slug>/ctx/src/index.ts
  → same bytes at /app/data/pi-arcane/<slug>/ctx/src/index.ts inside Arcane
  → contextDir = /app/data/pi-arcane/<slug>/ctx
```

The manifest from §3.4 moves to `/files/<slug>/manifest.json` (still outside `ctx/`) and is read back
with an authenticated `GET`, which is faster and simpler than Arcane's `browse/content`.

### 7.5 Arcane's builder has no registry session

Independent of upload, and worth recording because the error names neither cause nor fix:

```
failed to resolve source metadata for docker.io/library/nginx:1.27-alpine: no active sessions
```

Arcane invokes BuildKit without an attached client session, so BuildKit cannot talk to a registry.
**Only base images already in the host's image store resolve.** Measured on 2026-08-14:

| Case | Result |
| --- | --- |
| `FROM nginx:alpine` (on the host) | builds |
| `FROM nginx:1.27-alpine` (absent) | `no active sessions` |
| same build after `POST /images/pull` | builds |
| `pull: true` on the build request | no effect |
| `provider: docker` / `classic` / `buildkit` | `unknown build provider` — no override exists |
| compose path (`up` builds the service) | fails identically |

It looks intermittent only because it depends on what happens to be cached: the first `alpine:3.20`
probe failed for this reason, then `nginx:alpine` succeeded and hid it.

Worked around in [extension/baseimages.ts](extension/baseimages.ts): before any build, the
Dockerfile's `FROM` and `COPY --from=` images are parsed (handling `--platform`, `AS` stages, stage
references, `scratch`, and `ARG` interpolation) and any that are missing are pulled through Arcane's
own `POST /images/pull`, which does have credentials. Both paths do this — the compose path reads
each building service's Dockerfile via `readBuildDirectives`. A build that fails anyway gets the
explanation appended rather than the bare BuildKit line.

The real fix belongs in Arcane: attach a session (or an auth provider) to its BuildKit client. Worth
reporting upstream — until then every Arcane build is limited to cached base images.

### 7.4 Impact on the plan

- §3.2 target resolution gains a **first** branch: if `upload.url` + `upload.token` are configured,
  use the sidecar. Order becomes sidecar → builds workspace → volume API → git-only.
- §3.5 gains a `SidecarFileSurface` implementing the same `FileSurface` interface (upload/read via
  the sidecar, delete via Arcane's volume API). Everything above that interface is unchanged.
- Config ([config.ts](extension/config.ts)) gains `upload: { url, token, containerPath }`, with
  `token` accepting the same `$ENV_VAR` / `!command` forms as `apiKey`, and `containerPath`
  defaulting to `/app/data/pi-arcane`. Since the sidecar shares the Arcane key, `token` defaults to
  whatever `apiKey` resolves to and only needs setting if the two ever diverge. The live
  `.pi/arcane.json` is already written this way (`"token": "$ARCANE_API_KEY"`).
- §2 constraints 1 and 3 drop away; the pre-flight file-size rejection becomes a much higher bound.
  Constraints 5–7 (edge environments, manifest-not-mtime, BuildKit retry) still apply.
- Expected cost: a plain HTTP `PUT` to a Go server on a LAN-ish link is single-digit milliseconds, so
  a few hundred files at concurrency 8 lands in seconds rather than a minute, and incremental syncs
  become effectively instant.
- Adds phase 1b to §4 (~0.25 d): the `SidecarFileSurface` plus config plumbing.
