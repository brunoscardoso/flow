# Flow

An Electron IDE where the agent thread is a first-class surface. Private
workspace package (`@plan-flow/app`) inside the plan-flow repo — the root
`planflow-ai` CLI package publishes independently and does not include any of
this.

- **Platform**: macOS (arm64) is the reference target; **Windows (x64)** is
  supported. Both local builds are UNSIGNED. Windows additionally has **no
  auto-update feed** (`win.publish: null`) — updates are a manual re-download —
  and SmartScreen warns on first launch. See [Windows](#windows). Linux and
  arm64 Windows are explicit non-goals.
- **Stack**: Electron 43 (exact pin), electron-vite (CJS main + preload,
  Monaco renderer with worker chunks), better-sqlite3, node-pty, Monaco,
  xterm, typescript-language-server, `@anthropic-ai/claude-agent-sdk`.

## Dev workflow

```bash
# from the repo root
npm install            # installs the workspace (see allow-scripts caveats below)
npm run app:dev        # electron-vite dev (HMR renderer, watch main/preload)

# or from app/
npm run dev
```

Typecheck (two projects — Node-side and renderer-side):

```bash
npm run typecheck -w app
# equivalent to:
#   tsc --noEmit -p app/tsconfig.node.json
#   tsc --noEmit -p app/tsconfig.web.json
```

Build only (no packaging): `npm run build -w app` → `app/out/{main,preload,renderer}`.

## Packaging

```bash
npm run package -w app        # electron-vite build + electron-builder --mac --dir
npm run package:dmg -w app    # same, plus a dmg
npm run package:win -w app    # electron-builder --win → nsis installer + portable exe
```

Output:

| Command | Artifacts |
|---------|-----------|
| `package` | `app/dist/mac-arm64/Flow.app` (drag into /Applications if you want it there) |
| `package:dmg` | the above, plus a dmg |
| `package:win` | `app/dist/Flow-<version>-x64-setup.exe`, `app/dist/Flow-<version>-x64-portable.exe`, and the `app/dist/win-unpacked/` payload both wrap |

Each of them runs `verify:agent-binary` first — see [Native modules](#native-modules).
Config lives in `app/electron-builder.yml`.

`package:win` must run **on Windows**. `electron-builder --win --dir` will
produce a `win-unpacked` tree from a Linux/WSL host, but the nsis step there
dies on `spawn wine ENOENT`, and the tree itself is unusable on Windows anyway
(see [Windows](#windows) — one checkout per environment). The macOS-only
pipelines (`release`, `ship`) refuse by name off-macOS.

`install:local` runs on **both**: it builds the release artifact for the host
and installs it where that OS keeps an installed Flow — ditto into
`/Applications` on macOS, and on Windows the NSIS `setup.exe` run with `/S`
(per-user, no elevation). It goes through the installer rather than copying
`win-unpacked` into `%LOCALAPPDATA%` so the shortcuts, the uninstall entry and
the replacement of a previous install stay the installer's job — and so the
one artifact Windows users actually run gets exercised, which no CI does.

Notable, deliberate choices (rationale in comments in `electron-builder.yml`):

- **`asar: false`** — three components must be real, spawnable files and
  `child_process.spawn` is not asar-patched: node-pty's `spawn-helper`,
  typescript-language-server's `lib/cli.mjs` (run as an
  `ELECTRON_RUN_AS_NODE` child), and the Claude Agent SDK's native `claude`
  binary (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, ~240MB, which
  the SDK resolves via `createRequire().resolve()` with no asar awareness).
  With asar enabled, each would need `app.asar → app.asar.unpacked` path
  rewrites in `src/`. asar buys nothing for an unsigned local build.
- **`npmRebuild: false`** — the tree on disk is already correct (see below);
  electron-builder must not rebuild at package time.
- **`identity: null`** — signing skipped entirely. The `Flow` executable keeps
  the ad-hoc signature from the Electron distributable, which is enough to
  launch on arm64. If Gatekeeper complains after moving the bundle around:
  `codesign --force --deep --sign - dist/mac-arm64/Flow.app`.
- Renderer-only deps (`monaco-editor`, `@xterm/*`) are excluded from the
  bundle — vite bundles them into `out/renderer`.
- Only `darwin-arm64` node-pty prebuilds ship; foreign prebuilds are excluded.

## Setup (fresh clone)

Requirements: **Node 22**. No C++ toolchain, no Python — both native modules
ship N-API prebuilds that load under Electron as-is, on macOS, Linux and
Windows alike (see [Native modules](#native-modules)).

Then:

```bash
npm install    # runs the app postinstall, which rebuilds native modules for Electron
npm run dev -w app
```

The app workspace's **`postinstall` (`scripts/postinstall.mjs`) makes sure the
native modules can load under Electron** — no manual step. Since better-sqlite3
13 there is nothing to compile (below), so it reports that and only restores
node-pty's exec bit. Skip it with `PLANFLOW_SKIP_NATIVE_REBUILD=1` (e.g. CI that
doesn't run the app).

## Native modules

Two native modules, and since better-sqlite3 13 the same story for both: **N-API
prebuilds, no compiler, no rebuild step, on any platform.**

- **better-sqlite3** (v13): runs on the N-API and ships one prebuilt binary per
  platform *inside its own npm package* (`prebuilds/win32-x64.node`,
  `darwin-arm64.node`, …). N-API binaries are ABI-stable across Node and
  Electron, so the same file loads in both. Verified live: v13.0.3 under
  Electron 43 on Windows 11 with no Visual Studio and no Python installed.

  `npm run rebuild -w app` still exists and is safe to run — it detects the
  N-API package and exits saying there is nothing to do.

  > **v12 and earlier were the opposite**, and the difference is easy to
  > misread. They used `prebuild-install`, which fetches from the GitHub
  > **release assets** — and no `electron-v148` (Electron 43) asset is
  > published there, so compiling against Electron headers was the expected
  > path on *every* platform. v13 publishes no release assets either, because
  > it moved its prebuilds into the package; reading the release page alone
  > makes v13 look like it has none at all.

  If the app is ever pinned back to ≤ 12, `scripts/rebuild-native.mjs` takes
  over again: direct `node-gyp rebuild` in the module dir with
  `--target=<pinned electron> --dist-url=https://electronjs.org/headers`. Not
  `@electron/rebuild` / `electron-builder install-app-deps` — those walk node
  resolution to the repo root and fail on any sibling copy of the same module
  (forbidden-pattern #8).

  Note: `electron` in `app/package.json` is pinned EXACTLY (`43.1.0`, no `^`).

- **node-pty** (hoisted to root `node_modules`): ships N-API prebuilds
  (`prebuilds/<platform>-<arch>/pty.node`) that work under Electron as-is —
  never needs a rebuild. Its only quirk is the `spawn-helper` exec bit (below),
  which is a darwin/linux concern only.

  Careful with a **stale `build/` directory**: node-pty's loader checks
  `build/Release` BEFORE `prebuilds/`, so a `build/` left behind by an install
  from another OS (e.g. the same checkout used from WSL) shadows the correct
  prebuild and the app dies with `ERR_DLOPEN_FAILED`. Deleting `build/` is the
  fix.

## allow-scripts caveats

Sandboxed environments with an allow-scripts policy (e.g. Claude Code) block
package postinstall scripts. Two consequences here:

1. **node-pty's `spawn-helper` loses its exec bit** — its postinstall
   normally sets it. Symptom: every terminal spawn fails with `EACCES`.
   Fix (idempotent, checks both node_modules roots):

   ```bash
   node scripts/fix-native-perms.mjs
   ```

2. **electron's postinstall may not run** on a fresh clone (no
   `node_modules/electron/dist`). Approve/run electron's install script, or
   run `node node_modules/electron/install.js` once.

After any fresh `npm install`, the safe sequence is:

```bash
node scripts/fix-native-perms.mjs
npm run rebuild -w app        # only if better-sqlite3 was reinstalled
```

## Windows

Windows x64 is a supported target. It is **unsigned**, has **no auto-update**,
and is **not covered by CI** — there is no Windows CI and adding it is an
explicit non-goal. Verification is a manual pass over
[`docs/windows-verification-checklist.md`](docs/windows-verification-checklist.md),
which is the authority on what "works on Windows" means. **Run it after any
change that touches the platform layer.**

### Prerequisites

| | |
|---|---|
| **Windows 10 1809+ / Windows 11, x64** | `win.target` is `arch: [x64]` only — there is no arm64 artifact. The Window Controls Overlay titlebar needs a modern Windows 10+. |
| **Node 22** | Matches `@types/node` ^22 and Electron 43's embedded Node line. (The root `engines.node` floor of `>=18` is the published CLI's floor, not the app's.) |

**No C++ toolchain is needed.** Both native modules ship N-API prebuilds that
load under Electron unchanged (see [Native modules](#native-modules)) — verified
live on Windows 11 with no Visual Studio and no Python installed: `npm run dev`
starts the app, opens its window, and spawns a shell in the embedded terminal.

> This section used to require Visual Studio Build Tools and Python 3, on the
> grounds that better-sqlite3 published no Electron 43 prebuild anywhere. That
> was true of v12 and read off the GitHub release assets; v13 ships its
> prebuilds inside the npm package, where that check never looked. If the app
> is ever pinned back to better-sqlite3 ≤ 12, the toolchain becomes a hard
> prerequisite again — on every platform, not just Windows — and note that the
> `python.exe` under `%LOCALAPPDATA%\Microsoft\WindowsApps` is the **Microsoft
> Store alias stub**, not a Python; node-gyp fails on it.

One Windows-specific trap that is NOT about the toolchain: if the same checkout
has also been installed from WSL, `node_modules` can hold Linux `.node` binaries
that Windows refuses with *"is not a valid Win32 application"*. Reinstall on
Windows, and delete any stale `node_modules/node-pty/build` (its loader prefers
`build/Release` over the correct `prebuilds/win32-x64`).

Two rails to know about, both of which fire on a `npm install` that **exits 0**:

- `node_modules/electron/dist/` missing (observed live) — the postinstall names
  it and the fix is `node node_modules/electron/install.js`.
- the native rebuild failing — deliberately **non-fatal**, so the install
  completes and the app then refuses to start.

### First launch: SmartScreen is expected

Both Windows artifacts are unsigned (no Authenticode certificate; signing needs
a paid OV/EV cert), so Microsoft Defender SmartScreen interposes on first launch
of the setup `.exe` — and again on the portable `.exe`, which is a separate
unknown binary. The path through it:

1. **"Windows protected your PC"** appears, offering only **Don't run**.
2. Click **More info** → it expands to show *Publisher: Unknown publisher*.
3. Click **Run anyway**.

This does not recur for the installed `Flow.exe` afterwards. Downloading the
artifact in a browser may raise a separate "isn't commonly downloaded" warning —
same cause, different surface. On a machine with SmartScreen policy set to
*Block* there is no **Run anyway** at all.

`electron-builder` logs one code-signing skip notice during `package:win` and
does not fail: `forceCodeSigning` is left at its default `false` on purpose.

The installer itself is deliberately unobtrusive — assisted (`oneClick: false`,
with a directory picker), **per-user into `%LOCALAPPDATA%`**, and it **never
requests elevation** (`perMachine: false`, `allowElevation: false`). An unsigned
installer that opens a UAC prompt from an unknown publisher is the worst
possible first impression; if you see one, that is a defect.

### One checkout per environment — do not share a tree with WSL

A repo checked out once and used from both Windows and WSL will break, in two
independent ways. Use **two clones**.

1. **The `flow` link is a different object in each environment.**
   `planflow-ai init` creates a **junction** on Windows (no admin rights
   needed) and a **POSIX symlink** on Unix. Neither environment can follow the
   other's. Verified live on Windows 11: a WSL-created `flow` link reports
   `Attributes: Archive, ReparsePoint` with an **empty** `LinkType` and
   **empty** `Target`, `flow/discovery` is unreachable, and Node's
   `isSymbolicLink()` returns **false** — which is why the detector in
   `src/cli/utils/files.ts` tests "`lstat` sees it, `stat` does not" rather
   than trusting `isSymbolicLink()`.

2. **`npm install` resolves platform-specific optional dependencies for the
   host it runs on** — `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` (the
   ~240MB native `claude` binary), node-pty's prebuilds and its vendored ConPTY
   binaries, and the compiled `better_sqlite3.node`. A WSL-installed tree holds
   a Linux ELF and **no** `claude-agent-sdk-win32-x64` at all. The source files
   are byte-identical; the tree is not.

The CLI names the situation rather than dangling in silence:

```
flow link does not resolve: <path>\flow -> (unreadable reparse point)
It was created under WSL — a POSIX symlink Windows cannot follow.
One checkout cannot serve both environments: the link is a different
object in each, so re-create it in the environment you are using.
  rmdir "<path>\flow"
  npx planflow-ai init
Or keep using this checkout from WSL, where the link already resolves.
```

`rmdir` removes only the link; nothing inside the target is deleted. The
mirror-image message exists for a Windows junction seen from WSL.

## Architecture one-pager

Strict three-process split; the renderer has no Node access (contextBridge
preload only, strict CSP in production).

### Main process (`src/main/`)

| Manager | File | Role |
|---------|------|------|
| AgentManager | `agent/agent-manager.ts` | One Claude Agent SDK session per thread. The SDK is ESM-only, loaded via a runtime dynamic `import()`; it spawns the native `claude` CLI binary resolved from `@anthropic-ai/claude-agent-sdk-darwin-arm64`. |
| PermissionBroker | `agent/permissions.ts` | canUseTool gate — rule matching, always-allow persistence, ask-user relay to the renderer. |
| EditTracker | `agent/edit-tracker.ts` | Inline diff review (ADR-001): captures approved Edit/Write intents pre-write, verifies applied hunks post-write. |
| StreamBridge | `agent/stream-bridge.ts` | SDK stream → typed `AgentStreamEvent`s for the renderer. |
| ThreadStore / db | `store/` | better-sqlite3 database (threads, messages, tool_calls, permission_rules, workspaces) with versioned migrations. |
| CredentialsManager | `credentials.ts` | `~/.flow/credentials.json`, 0600, never injected into prompts. |
| PtyManager + bash-bridge | `terminal/` | node-pty terminals; agent Bash mirrored into a terminal surface via SDK hooks. |
| LspManager + tsserver adapter | `lsp/` | Generic LSP client; typescript-language-server spawned as `process.execPath cli.mjs --stdio` with `ELECTRON_RUN_AS_NODE=1`, `typescript/lib` as tsserver fallback. |
| GitManager | `git/` | Status/diff/log for the git viewer. |
| FlowObserver | `flow/flow-observer.ts` | Read-only watcher over `flow/` (heartbeat events, blocked prompts, STATE.md). |
| WorkspaceManager | `workspace/` | Workspace roots + file tree/watching. |

### IPC contract (`src/shared/ipc-contract.ts`)

Single typed contract shared by all three processes: request/response
channels plus event streams (agent stream, permission requests, pty data, LSP
notifications, flow events). `src/main/ipc/` binds handlers; the preload
(`src/preload/index.ts`) exposes exactly this surface via `contextBridge`.

### Renderer (`src/renderer/`)

| Surface | Dir | Role |
|---------|-----|------|
| Shell | `shell.ts`, `components/` | Layout, panes, theming (`theme/`). |
| Threads | `threads/` | Agent conversation UI — the first-class surface. |
| Editor | `editor/` | Monaco, LSP wiring, inline diff review UI. |
| Terminal | `terminal/` | xterm views over pty IPC. |
| Git | `git/` | Changes/history viewer. |
| Flow | `flow/` | flow/ observer surfaces (heartbeat, blocked prompts, state). |
| Palette | `palette/` | ⌘P quick-open: a floating overlay blending files, threads, and commands into one ranked list (`>` = command mode). Pure core (fuzzy/query/rank) is DOM-free + unit-tested; the view reuses the settings-overlay chrome and `<fl-list>`. |

ADRs live in `app/docs/` (ADR-001: edit interception strategy), alongside
[`windows-verification-checklist.md`](docs/windows-verification-checklist.md) —
the manual pass that stands in for the Windows CI this project does not have.
