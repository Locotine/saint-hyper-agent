# Saint Beta

Saint Beta is a packaged prerelease flavor of the desktop app. It is a separate
application that installs and updates side-by-side with stable Saint, and it never
shares stable's data directory or update feed.

## The short version

- **One branch.** Every PR merges into `main` as usual. There is no Beta branch.
  The release tag decides which app gets built from `main`:
  - `vX.Y.Z` builds **Saint** (Stable).
  - `vX.Y.Z-beta.N` builds **Saint Beta**.
- **Beta is named after the next Stable.** After `v0.9.2` ships, the next Beta is
  `v0.9.3-beta.1`, then `v0.9.3-beta.2`, and so on until `v0.9.3` ships. Never tag
  `v0.9.2-beta.1` after `v0.9.2`: it sorts older than the Stable it follows.
- **Two separate apps.** Saint and Saint Beta install side by side, with separate
  data (`~/.saint` and `~/.saint-beta`) and separate update feeds. A Beta update is
  never offered to Stable, and the other way round.
- **Data only copies Stable → Beta.** Settings > Try Beta copies the user's Stable
  data into Beta. Nothing is ever copied back: "Switch back to Saint" reopens
  Stable with the data it already had.
- **Beta-only features** stay out of Stable through one list,
  `BETA_ONLY_FEATURES` in `packages/shared/src/betaFeatures.ts`. The code ships in
  both apps; Stable just switches listed features off. Remove the entry to promote
  a feature to Stable. See [Beta-only features](#beta-only-features).
- **Diagnostics are Beta-only.** Beta sends redacted error events, raw crash
  dumps, and anonymous usage counts to a private dashboard. Stable sends nothing. See
  [Diagnostics](#diagnostics).

### Release order

1. Merge the PRs for the release into `main`.
2. If Windows is shipping unsigned, set the repo variable
   `SAINT_ALLOW_UNSIGNED_WINDOWS_RELEASE` to the Stable version (for example
   `0.9.2`), then tag and publish `v0.9.2`.
3. Set the variable to the Beta version (`0.9.3-beta.1`), prepare its version
   commit on top of the Stable commit, then tag and publish `v0.9.3-beta.1`.
   With `SAINT_AUTO_BETA=1` this version commit and tag are created automatically
   after the Stable publish. Do not push Beta package versions onto `main`.
4. More Betas (`beta.2`, `beta.3`, …) can follow from newer `main` commits at any
   time. Stable only moves when a `vX.Y.Z` tag is cut.

The rest of this file is the detailed reference.

## Identity

- App name: `Saint Beta`
- Bundle ID: `com.locotine.saint.beta`
- Desktop origin: `saint-beta://app`
- Saint data: `~/.saint-beta`
- Electron profile: `saint-beta`
- Executable: `saint-beta` (Linux AppImage bundle), `Saint Beta.app`, `Saint Beta.exe`
- Windows installer GUID: `e5cb6c41-44ef-4989-a949-8b42c1d9b788` (separate Add/Remove
  Programs entry; the stable GUID is unchanged)

## App icon

There is no icon picker. Saint uses its default artwork and Saint Beta the blue
Beta artwork. On launch each app re-applies its own icon, which also clears an
icon chosen with the picker in earlier builds; the old saved choice is ignored.

## How it differs from Canary

Canary is a local source build managed by `bun run canary:*` scripts and updates only
through those scripts. Beta is a packaged release artifact: it is built, signed, and
published by the same release workflow as stable, and it updates through
`electron-updater` like the production app.

## Update channel isolation

- Stable builds follow the `saint` updater channel with `allowPrerelease=false` and
  only ever read the repository's GitHub Latest release.
- Beta builds follow the `beta` updater channel with `allowPrerelease=true`.
  electron-updater's GitHub provider reads the releases atom feed and takes the
  newest release that is not tagged for a custom channel — so if a stable
  release is newer than the latest beta tag, beta installs see "no update"
  until the next beta release is cut. Always cut a new beta right after each
  stable release.
- Beta releases carry `beta-mac.yml`, `beta.yml`, and `beta-linux.yml`
  manifests. The `latest-*.yml` files are uploaded on beta releases too, but
  they are inert there: stable installs only read them from the Latest
  release, which beta tags never become. A beta release can never be offered
  to a stable install, and a stable release never carries beta manifests.
- The desktop additionally gate-checks every candidate's version against its
  lane (`isUpdateVersionAllowedForFlavor`): beta installs accept only
  `*-beta.*` versions and production installs accept only stable versions.
  This matters because electron-updater's GitHub provider falls back to
  `latest-mac.yml` when the channel manifest is absent — without the gate, a
  beta install could be offered a stable build, and installing it would
  silently swap the app to the other flavor and home directory. Crossing lanes
  always happens by installing the other app, never by update.
- `allowDowngrade` stays `false` on both trains; moving back to stable happens
  by opening the stable app (see [Leaving beta](#leaving-beta)), never by update.
- Pending-update caches are scoped per flavor (`~/Library/Caches/saint-desktop-beta-updater`
  on macOS), so a downloaded beta update never collides with stable's pending
  update state.

## Cutting a beta release

Beta releases ride the same `release.yml` workflow. The lane is selected entirely by
the tag shape: a version whose first prerelease identifier is `beta` resolves to the
beta channel and the beta desktop flavor; every other suffix keeps today's behavior.

1. Select the target `main` commit and inspect its CI results. Finalize the release
   notes and documentation, then prepare the Beta version on top of that commit
   in an isolated checkout. Release preflight
   (`scripts/verify-release-source-provenance.ts`) requires the four release
   `package.json` versions to equal the tag version, but beta version commits
   never land on `main`, so `main` keeps the stable version:
   - `git switch --detach upstream/main`
   - `node scripts/update-release-package-versions.ts X.Y.Z-beta.N`
   - Use the next Stable base `X.Y.Z`, ahead of the latest published Stable, so
     the Beta sorts after the currently installed release.
   - `N` starts at `1` and increments per beta cut on the same base version.
2. Follow the [release checklist](docs/release.md#4-ongoing-release-checklist):
   complete the required local checks after the version, lockfile and notes are
   final; resolve the Beta update policy and set the exact Windows unsigned
   exception when needed; then commit, tag and push only the tag. The tag workflow
   supplies the final full workspace test suite and desktop build on that exact
   Beta candidate:
   - `git tag vX.Y.Z-beta.N` and `git push upstream vX.Y.Z-beta.N`
   - An ordinary Beta uses this one publication run. Full build-only qualification
     followed by a tag build is not required; use a scoped build-only stage only
     when diagnosing a native or packaging change.
   - Native packaging and qualification share one runner and can overlap the
     quality/server-test gates once preflight and prepared inputs pass. GitHub
     and npm publication depend directly on all quality/server-test gates and
     native success; Beta still never publishes npm `latest`.
3. The workflow publishes a GitHub **prerelease** named `Saint vX.Y.Z-beta.N` with
   beta installers, `beta-*.yml` manifests, and blockmaps. It is never marked Latest,
   never bumps package versions on `main`, and never publishes the npm `latest`
   dist-tag.
4. For a failure on the same source SHA, resume the existing run with
   `gh run rerun RUN_ID --failed` as described in
   [release recovery](docs/release.md#resume-a-failed-release). A first successful
   native attempt creates no checkpoint. After a failure with validated provenance,
   the workflow rechecks integrity before retaining a candidate for 30 days; a
   retry in that same run/SHA can restore it and skip packaging. Corruption or
   artifact API errors fail closed; missing/expired candidates require rebuild.
   A crash/cancellation that prevents checkpoint upload, or a notarization failure
   before validated provenance, cannot recover from the old runner's local files.
   Do not dispatch a duplicate publication run. A manual publication dispatch on an existing tag
   is an alternative trigger when no tag-triggered run is being used:
   `gh workflow run release.yml --ref vX.Y.Z-beta.N -f version=X.Y.Z-beta.N -f publish_release=true`.
   Publishing from a branch ref is refused by preflight; a new source SHA requires
   a newly verified candidate rather than relabeling earlier artifacts.
5. Always cut a new beta right after each stable release. The GitHub provider
   picks the newest non-custom-channel release in the feed, so a newer stable
   tag shadows every older beta until a fresh beta prerelease out-sorts it.
   With the repository variable `SAINT_AUTO_BETA=1`, the release workflow does
   this automatically after each stable publish: it tags a version commit made
   on top of the stable commit as `vX.Y.(Z+1)-beta.1` (skipped when any beta
   for that base already exists, or when the release just published is not the
   highest stable tag — a re-release of an old line does not cut a beta).
   Later betas on the same base stay manual.

### Signing

Beta builds use the same signing setup as stable. Publishing requires the macOS
signing/notarization secrets, and Windows uses Azure Trusted Signing or the same
version-scoped unsigned exception (`SAINT_ALLOW_UNSIGNED_WINDOWS_RELEASE` set to the
exact `X.Y.Z-beta.N` version without the `v`). The exception matches one exact
version, so the automatic post-stable beta needs Azure signing or the variable
set to that beta version, otherwise its Windows build blocks publication.

## Building a beta artifact locally

```bash
bun run dist:desktop:artifact -- --platform mac --target dmg --arch arm64 --flavor beta
```

`--flavor` accepts `production` (default), `canary`, `cua`, or `beta`, and the
`SAINT_DESKTOP_FLAVOR` env var is equivalent. The packaged `package.json` embeds the
resolved flavor (`saintDesktopFlavor`), so a packaged build cannot silently lose its
identity at runtime; on packaged builds the embedded value wins over the env var.

### Updates from a GitLab Releases feed

A fork hosted on GitLab can ship updates from a **public** GitLab project, without CI. The updater reads the project anonymously, so keep the source in a private project and use a separate public one only for releases. Its package registry must allow anonymous downloads (the default for public projects), and it needs one commit on `main` to tag releases from.

1. On every build machine, build with the feed configured. The build embeds it in `app-update.yml`:

   ```bash
   export SAINT_DESKTOP_UPDATE_GITLAB_PROJECT=<namespace>/<releases-project>
   # SAINT_DESKTOP_UPDATE_GITLAB_HOST=git.example.com for self-managed GitLab
   # --flavor production builds Saint (Stable); --flavor beta builds Saint Beta.
   bun run dist:desktop:win -- --flavor production        # Windows: NSIS installer
   bun run dist:desktop:linux -- --flavor production      # Ubuntu: AppImage
   bun run dist:desktop:dmg:arm64 -- --flavor production  # macOS
   ```

2. On each machine, upload its output folder. Every run adds its files to the release `v<version>`, which it creates on first use:

   ```bash
   GITLAB_TOKEN=<token with api scope> bun run release:gitlab -- release
   ```

   Uploads are generic packages (`saint-desktop/<version>/<file>`), linked from the release by file name. They are the names `latest.yml`, `latest-linux.yml` and `latest-mac.yml` that the updater looks up. Merge the two macOS manifests first with `scripts/merge-mac-update-manifests.ts` when you ship both architectures.

   Every release also carries `scripts/linux/install-saint.sh` and the one-time Beta → Stable copy scripts `scripts/copy-saint-beta-data.sh` (macOS/Linux) and `scripts/copy-saint-beta-data.ps1` (Windows); the upload picks them up from the folder. Users run `bash install-saint.sh` after downloading the Stable AppImage: it copies it to `~/Applications/saint.AppImage` (a name without a version, so updates overwrite it in place), adds the menu entry, icon and `saint://` handler, offers to install `libfuse2` and to remove an older `.deb` (including packages from older builds), and `--uninstall` removes it again. The copy scripts move `~/.saint-beta/userdata` into `~/.saint/userdata` with both apps quit, skip runtime entries the same way the in-app Stable → Beta copy does, and keep the replaced Stable data as a backup.

3. Installed apps check the newest release and update in place on Windows (NSIS) and Linux (AppImage only; a `.deb` never updates). macOS installs only builds signed and notarized with a Developer ID. An unsigned Mac sees the update, fails to install it, and after two failures offers the GitLab release page for a manual download.

Builds made before the feed was configured have no `app-update.yml` and never update. Install a feed-enabled build once by hand. Each flavor only takes its own lane (see [Update channel isolation](#update-channel-isolation)): Saint takes `vX.Y.Z` releases and Saint Beta takes `-beta.N` releases, and the updater reads only the newest release of the project, so keep one lane per releases project.

## Joining beta from stable

The stable app offers a one-click handoff under **Settings → General → Saint Beta**:

- **Install Saint Beta** (macOS) downloads the newest `v*-beta.N` release's
  `beta-mac.yml`, picks the zip for the current architecture, verifies its
  sha512, unpacks it with `ditto`, checks the bundle id is
  `com.locotine.saint.beta`, and verifies the code signature is valid
  and signed by the same team id as the running app (`codesign --verify
--deep --strict` plus a `TeamIdentifier` match; skipped when the running
  build is itself unsigned). Only then is `Saint Beta.app` moved into
  `/Applications` — then opened. On other platforms the card opens the public
  download page instead.
- **Copy my data and open** installs first when needed, then writes a marker at
  `~/.saint-beta/import-requested.json` and launches the beta app. On its next
  startup the beta server consumes the marker, snapshots stable's database,
  copies settings and provider secrets, then deletes the marker. The button
  first confirms that this replaces existing Beta chats, projects, and settings;
  work created only in Beta will be lost, while Stable remains unchanged. The snapshot
  uses `VACUUM INTO` when the source is quiescent; while stable is running it
  holds `state.sqlite` under `PRAGMA locking_mode = EXCLUSIVE`, so the importer
  falls back to a file-level copy of the database and its WAL, retried until no
  checkpoint or WAL restart landed mid-copy (it fails rather than import a torn
  pair), and vacuums that staged copy into a checkpointed snapshot. Either way
  the result is a consistent point-in-time copy and the outcome is written to
  `~/.saint-beta/import-result.json` so the stable settings card can report
  success or the failure reason. The importer stages every file first, rejects
  symbolic links in copied state, and rolls back normal filesystem commit errors
  rather than reporting success with only part of the state copied.
- Only a packaged beta (`SAINT_DESKTOP_BUNDLE_ID` is the beta bundle id)
  consumes the marker, and only from stable's data folder (`SAINT_STABLE_HOME`
  handed over by stable, else `~/.saint`). A stray marker in any other home
  is ignored.
- If stable's database has migrations newer than the installed beta knows, the
  import fails with "Update Saint Beta" instead of leaving beta unable to
  start. Any leftover beta `state.sqlite-wal`/`-shm`/`-journal` is removed
  before the snapshot is swapped in, so an old WAL cannot replay over it.
- **Open Beta** launches the installed beta app without touching data.
- The import button is disabled while a beta server is running so an in-flight
  beta never reads a half-written snapshot; quit beta first, then import.
- Launch/import are refused unless the running app is a production-flavor build.
- On macOS the beta app is spawned by executable path
  (`Saint Beta.app/Contents/MacOS/Saint Beta`) with a sanitized environment:
  stable's `SAINT_HOME`, `SAINT_DESKTOP_SMOKE_USER_DATA`, and server auth
  variables are stripped, and beta gets `SAINT_BETA_HOME` (plus
  `SAINT_DESKTOP_SMOKE_USER_DATA` when `SAINT_BETA_USER_DATA` is set).

The marker format lives in `packages/shared/src/betaChannel.ts`
(`BetaImportRequest`, `BetaImportResult`); the desktop side is
`apps/desktop/src/betaChannel.ts`, the download/install flow is
`apps/desktop/src/betaInstaller.ts`, and the consuming import is
`apps/server/src/betaImport.ts`.

### Local demo

Everything about the install location and data home can be redirected with
environment variables, so a demo never touches a real `~/.saint`,
`~/Library/Application Support/saint`, or `/Applications`:

- `SAINT_BETA_FEED_URL` — base URL serving `beta-mac.yml` and the files it
  lists (for example a local static server). Without it, the newest GitHub
  `v*-beta.N` release is used.
- `SAINT_BETA_INSTALL_DIR` — directory the app bundle is moved into and
  probed in first (default `/Applications`).
- `SAINT_BETA_HOME` — overrides `~/.saint-beta` everywhere it is resolved:
  stable's import marker path, the beta app's own base dir, and the
  running-server probe.
- `SAINT_BETA_USER_DATA` — Electron `userData` dir handed to the launched
  beta (only honored on the beta and cua flavors and source builds).
- `SAINT_HOME` / `HOME` — stable's data dir (beta ignores `SAINT_HOME`, so a
  globally exported value can never point beta at stable's data) and the
  `userData` base, respectively; overriding `HOME` isolates the Electron profile exactly like
  `scripts/verify-packaged-desktop-startup.ts` does.

The import copies settings, provider secrets, and a database snapshot. It never
copies logs, diagnostics queues, runtime files, other import markers, database
sidecars (`state.sqlite-wal`/`-shm`/`-journal`), or `*.lifecycle-lock`
directories — a leaked lock directory would make beta refuse to start while the
stable process is alive. Nothing is ever written into the stable home: the
marker and the result both live in the beta home.

## Leaving beta

Beta shows **Switch back to Saint** under **Settings → General**. It opens
stable and quits beta; on macOS it can also move `Saint Beta.app` to the Trash
(checked by default). Stable was never changed by the switch, so it opens with
the chats and settings it had before.

- Beta data is never copied back. Beta can carry database migrations and data
  for features stable does not have yet, so a copy could fail or corrupt
  stable's `state.sqlite`. The dialog says so plainly. `~/.saint-beta` is
  kept, so reinstalling beta picks up where the user left off.
- Stable is found through `SAINT_STABLE_EXECUTABLE`, which stable sets on the
  beta it launches (with `SAINT_STABLE_HOME` for its data dir), then through
  `/Applications/Saint.app`, `~/Applications/Saint.app`, or the stable NSIS
  uninstall key on Windows. When none is found the card offers the stable
  download page instead.
- Stable is spawned with beta's per-process overrides stripped
  (`SAINT_DESKTOP_SMOKE_USER_DATA`, server auth variables) and `SAINT_HOME`
  restored from `SAINT_STABLE_HOME` when stable handed one over. An already
  running stable just comes to the front through its single-instance lock.
- The Trash step only runs for a packaged bundle named `Saint Beta.app`, so a
  source or dev build can never trash Electron itself.

## Beta-only features

`packages/shared/src/betaFeatures.ts` holds `BETA_ONLY_FEATURES`, the single
list of features that ship in Beta but not in Stable. `isBetaFeatureEnabled`
turns a listed feature off only for the `production` desktop flavor; Beta,
Cua, Canary, development, and non-desktop hosts keep it.

To put a feature behind the list:

- Add its key to `BETA_ONLY_FEATURES`.
- Gate it on the server, which is authoritative: resolve the host flavor with
  `desktopFlavorFromBundleId(process.env[SAINT_DESKTOP_BUNDLE_ID_ENV])` and
  refuse the capability there, not just in the UI.
- Hide it on the web with a constant built from
  `desktopFlavorFromProtocol(window.location.protocol, import.meta.env.DEV)` —
  hide entry points rather than disabling them, and coerce any persisted or
  replayed value to off so stale state cannot re-arm the feature.
- Keep any migrations or persisted fields additive and inert on Stable; a
  user's stored preference must survive a Beta → Stable round trip untouched.

Promote a feature to Stable by deleting its entry; every gate resolves itself.

Connectors (`mcp-connectors`) are available in Stable and Beta: Settings → Connectors,
RPCs, OAuth callbacks, proxy routes and saved connectors use the same shared policy.
Each app reads only the `mcp-connectors` secret in its own data home.
See [Connectors](docs/mcp-connectors.md).

The native editor (`native-editor`) is available in Stable and Beta: the same Code OSS
editing engine behind file editors, editable diffs and editable previews, TypeScript language
service and JavaScript debugger. Both apps expose the `editor.*` RPCs and the editor commands
in the Shortcuts sheet and Settings → Keybindings. Existing document ownership, save/conflict
handling and large-preview fallbacks remain unchanged.
See [Native editor intelligence](docs/editor/intelligence.md).

HTML visuals execute only in the desktop apps (Stable and Beta), where native subframe navigation is blocked.
HTTP-hosted clients retain native component visuals but never execute HTML. The trusted
bootstrap removes WebRTC capabilities before page scripts and stops parsing if that boundary
cannot be enforced. HTML messages cannot open external URLs through the host.

The feature list holds one entry, `remote-ssh` (Remote hosts); diagnostics retain their
separate Beta-only policy. Remote hosts run in the desktop main process, not the server:
the main process refuses every `desktop:remote-ssh-*` IPC on Stable, the preload exposes no
`desktopBridge.remoteSsh`, and Settings hides the Remote hosts section. The saved-host file
(`userdata/remote-ssh-hosts.json`) is inert on Stable. See [Remote access](REMOTE.md#3-remote-ssh-hosts-beta).
Inline visuals are available in Stable and Beta:
the `saint_show_visual` agent tool, its transcript rows, and the `orchestration.getInlineVisual`
read all use the shared policy. Both native component specs and sandboxed HTML retain their
existing rendering and interactions. Nothing is migrated; each app keeps visual documents
under its own attachments directory, without importing Beta data into Stable.

Hubs, Tasks, Inbox, Auto-fix CI, Oh My Pi, the rail sidebar layout, and message
trail sound are available in both apps.

Hubs became available in Stable 1.0.2. The same shared policy enables the Hub
APIs, Library, coordinator wakes, monitoring, check-ins, completion evaluations,
and web entry points in Stable and Beta. Existing saved Hubs in the current
app's data home remain Hubs; this promotion does not import Beta data into
Stable. Each app retains its own identity, data home, and update feed. Diagnostics
remain Beta-only and are independent of this feature list.

Tasks and its delegation APIs are available in Stable and Beta. Tasks takes
Kanban's navigation slot and preserves its saved order and visibility; its
List / Kanban switch keeps the board accessible. A client connected to an older
server that refuses Tasks returns to Kanban.

Inbox and its `stats.getRecap` RPC are available in Stable and Beta. Stable shows
chat attention, running and finished work, review requests, and the activity recap.
The to-do list, quick-add, delegation card, and **All tasks** link appear only where
Tasks is available, including Stable and Beta.

`pull-request-auto-fix` enables the opt-in **Auto-fix CI** action in a pull
request's menu. The server watches checks for an enabled PR and can ask its
linked agent chat to address failures in both Stable and Beta. It keeps the chat
permissions and retry limits, and waits for active work, approvals, and questions.
This does not enable automatic merging.

Message trail sound is opt-in under **Settings → Chat → Message trail sound**
on macOS desktop in both Stable and Beta. It follows system audio (macOS 14.2+),
the microphone, or both. The desktop IPC handler refuses other platforms,
and the web hides the selector on hosts without a supported desktop bridge.
Only loudness levels are sent to the trail, and the reader stops when the
visible trail no longer subscribes. First use can request macOS audio access.

## Diagnostics

Beta builds ship always-on diagnostics — crash reports plus anonymous usage
counts (which providers are used, how many chats and turns) — while stable
builds contain no sender code at all. See [diagnostics.md](docs/diagnostics.md) for
exactly what is collected, what usage counters exclude, and how the Cloudflare
ingest works.

## Data

Without an explicit import, beta starts with an empty `~/.saint-beta` home. It
does not copy, share, or migrate stable (`~/.saint`) or Canary
(`~/.saint-canary`) data on its own. Both apps can run at the same time: the
server binds an ephemeral port, single-instance locks are scoped per Electron
`userData`, and provider secrets are file-scoped inside each home.
