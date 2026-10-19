# Windows verification checklist

**This document stands in for Windows CI.** There is none, and adding it is an
explicit non-goal of the Windows port: the defects this checklist hunts are not
crashes, they are *missing capability*, and a green test suite on macOS cannot
see them.

Two of them in particular — **B1** (the agent's `PATH` was joined with `:`, so
the `planflow-ai` shim directory fused into one unresolvable entry) and **B3**
(the SDK's native binary was resolved from a hardcoded
`claude-agent-sdk-darwin-arm64/claude`) — sit on the agent path. Neither throws.
The app launches, the window is fine, the terminal works; the agent simply
cannot do a thing it used to do. **The only way to detect them is to run an
agent turn that shells out to a `planflow-ai` verb.** That is why the sequence
below does not stop at "the app opens".

Run the whole thing in one pass on a clean Windows x64 machine. Record a result
for **every** step, including the ones you skip.

---

## 0. Host requirements

| Requirement | Why | Check |
|---|---|---|
| Windows 10 1809+ / Windows 11, **x64** | `win.target` in `electron-builder.yml` is `arch: [x64]` only — there is no arm64 artifact. Window Controls Overlay (`titleBarOverlay`) needs a modern Windows 10+. | `[System.Environment]::OSVersion`, `$env:PROCESSOR_ARCHITECTURE` → `AMD64` |
| **Node 22** | The workspace is typed against `@types/node` ^22 and Electron 43 embeds a Node 22-line runtime. (The root `engines.node` floor of `>=18` is the published-CLI floor, not the app's.) | `node --version` |
| **Git** | Cloning, and the `flow` link remediation. | `git --version` |
| A Claude account to sign in with | Step 5 is not optional; it gates every step after it. | — |

**Build the app on the same Windows machine you test it on.** See §1.5.

---

## 1. Build

> Everything in §1 runs in a **Windows** shell (PowerShell or cmd), from a
> **Windows** checkout. Not WSL. See §1.5 for why that is not a preference.

### 1.1 — Clone and install

```powershell
git clone <repo> plan-flow
cd plan-flow
npm install
```

**Expected**: install completes, and the app workspace's postinstall
(`scripts/postinstall.mjs`) confirms the native modules load under Electron —
`[postinstall] better-sqlite3 <version> ships N-API prebuilds — no Electron rebuild needed`.

**Two known ways this goes wrong quietly:**

- **`npm install` exits 0 with `node_modules/electron/dist/` never downloaded.**
  Observed live on this project. The postinstall prints a boxed
  *"Flow: Electron binary was never downloaded"* rail naming the fix:

  ```powershell
  node node_modules/electron/install.js
  ```

  Nothing else complains until the app refuses to start.

- **No native rebuild is needed, and no C++ toolchain.** better-sqlite3 ≥ 13
  runs on the N-API and ships one prebuilt binary per platform *inside its own
  npm package*, ABI-stable across Node and Electron; node-pty already shipped
  N-API prebuilds. The postinstall says so and moves on:

  ```
  [postinstall] better-sqlite3 13.0.3 ships N-API prebuilds — no Electron rebuild needed
  ```

  Verified live on Windows 11 with no Visual Studio and no Python installed:
  the app starts, opens a window, and its embedded terminal spawns a shell.

  > The earlier claim here — *"better-sqlite3 publishes no npm-installable
  > Electron 43 (ABI 148) prebuild on any platform … 13.x ships no prebuild
  > assets at all"* — was checked against the GitHub **release assets**, which
  > is where `prebuild-install` fetched from for v12 and earlier. v13 moved its
  > prebuilds into the package itself, so the release page legitimately shows
  > none. It was true of v12; it was never true of v13.

  If the app is ever pinned back to better-sqlite3 ≤ 12, compiling becomes the
  expected path again on every platform, the boxed *"Flow: native module rebuild
  failed"* message means a missing toolchain, and the remedy is:

  ```powershell
  npm run rebuild -w app     # after installing the toolchain
  ```

☐ **RESULT**: _______________________

### 1.2 — Typecheck and tests

```powershell
npm run typecheck            # root
npm run typecheck -w app     # app (node + web projects)
npm test -w app
```

**Expected**: 0 errors from both typechecks; the app suite green.

☐ **RESULT**: _______________________

### 1.3 — Package

```powershell
npm run package:win -w app
```

This runs `verify:agent-binary` → `build:cli` → `electron-vite build` →
`electron-builder --win`.

**Expected** — `app/dist/` contains:

| Artifact | From |
|---|---|
| `Flow-<version>-x64-setup.exe` | `nsis.artifactName` |
| `Flow-<version>-x64-portable.exe` | `portable.artifactName` |
| `win-unpacked/Flow.exe` | the `dir` payload both wrap |

electron-builder logs **one skip notice for code signing** and does not fail —
`forceCodeSigning` is left at its default `false` on purpose, because there is
no Authenticode certificate for this project.

**Note**: `--win --dir` has been driven to exit 0 from a WSL host and produced a
complete `win-unpacked`, but the full `--win` run there dies on
`spawn wine ENOENT` at the nsis step. **No installer `.exe` has ever been
produced from WSL.** Producing one is the point of this step.

☐ **RESULT**: _______________________

### 1.4 — Verify the packaged agent binary

```powershell
node app/scripts/verify-agent-binary.mjs "app/dist/win-unpacked"
```

**Expected**: `verify-agent-binary OK (packaged app): ~2xxMB — …\claude.exe`.

This asserts the SDK's `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` is
present and ≥100MB inside the bundle. The POSIX exec-bit check is **skipped on
win32** by design (NTFS has no exec bit; Node reports `0o666` for every readable
file there, so the check would fail on a perfectly good `.exe`).

A failure here is a **pre-flight catch for B3's other half**: the binary the
resolver looks for and the binary the packager kept must be the same one — both
go through `app/shared/sdk-platform.mjs`.

☐ **RESULT**: _______________________

### 1.5 — Do not reuse a WSL checkout

**One checkout per environment.** A WSL-installed tree is not a Windows-runnable
tree, for two independent reasons:

1. **The `flow` link is a different object in each environment.**
   `planflow-ai init` creates a **junction** on Windows and a **POSIX symlink**
   on Unix. Neither environment can follow the other's. Verified live on
   Windows 11: a WSL-created `flow` link reports
   `Attributes: Archive, ReparsePoint` with an **empty** `LinkType` and **empty**
   `Target`, `flow/discovery` is unreachable, and Node's `isSymbolicLink()`
   returns **false**.

2. **`npm install` resolves platform-specific optional dependencies for the
   host it runs on.** A WSL tree has a Linux ELF `better_sqlite3.node`, Linux
   node-pty prebuilds, and **no** `@anthropic-ai/claude-agent-sdk-win32-x64` at
   all. The source files are byte-identical; the tree is not.

The CLI names this rather than dangling in silence:

```
flow link does not resolve: <path>\flow -> (unreadable reparse point)
It was created under WSL — a POSIX symlink Windows cannot follow.
One checkout cannot serve both environments: the link is a different
object in each, so re-create it in the environment you are using.
  rmdir "<path>\flow"
  npx planflow-ai init
Or keep using this checkout from WSL, where the link already resolves.
```

`rmdir` removes only the link — nothing inside the target is deleted.

☐ **RESULT**: _______________________

### 1.6 — Dogfood install (optional, and it replaces §1.3 + §2)

```powershell
npm run install:local -w app
```

One command for the whole of §1.3 → §2: it stamps a
`<next-patch>-local.<stamp>` version, runs the same pipeline as `package:win`
(nsis target only — the portable target is a second package of the same payload
and nothing installs it), then runs the installer with NSIS's `/S` switch.

**Expected**: no UAC prompt (`perMachine: false`, `allowElevation: false`), an
installed Flow under `%LOCALAPPDATA%\Programs\Flow`, and the app launched. A
running Flow is closed first — gracefully, then forced — so the installer can
replace its files.

It goes through the **installer**, not a copy of `win-unpacked` into
`%LOCALAPPDATA%`: the shortcuts, the uninstall entry and the replacement of a
previous install are the installer's job, and overwriting an installed Flow by
hand would delete its uninstaller and leave a dead Add/Remove Programs entry.
The version stamp is decorative here — `win.publish` is null, so there is no
feed for it to out-rank — but it names which local build is installed.

Doing §1.3 and §2 by hand is still the honest verification of the artifacts
themselves; this is the shortcut for repeated dogfooding.

☐ **RESULT**: _______________________

---

## 2. Install

```
app\dist\Flow-<version>-x64-setup.exe
```

**Expected**, from the `nsis:` block in `electron-builder.yml`:

- An **assisted** installer (`oneClick: false`) with a directory picker.
- **No UAC prompt.** `perMachine: false` + `allowElevation: false` — the install
  is per-user, into `%LOCALAPPDATA%`, and never asks for admin rights. *An
  unsigned installer that opens a UAC prompt from an unknown publisher is the
  worst possible first impression; if you see one, that is a defect.*
- A **desktop** shortcut and a **Start Menu** shortcut, both named `Flow`.
- No blockmap (`differentialPackage: false` — there is no update feed to
  consume one).

☐ **RESULT**: _______________________

### 2.1 — SmartScreen (expected, not a defect)

Both artifacts are **unsigned** — there is no Authenticode certificate for this
project, and getting one means buying a paid OV/EV cert. So Microsoft Defender
SmartScreen will interpose on first launch of the setup `.exe` (and again on
the portable `.exe`, which is a separate unknown binary).

The path a user must take:

1. A **"Windows protected your PC"** dialog appears. The only button offered is
   **Don't run**. There is no visible way forward.
2. Click the **More info** link. It expands to show *App:* the filename and
   ***Publisher: Unknown publisher***.
3. A **Run anyway** button appears. Click it.

After a successful install this does not recur for the installed `Flow.exe`.
Downloading the artifact in a browser may also produce a separate
"isn't commonly downloaded" warning that needs Keep/Keep anyway — same cause,
different surface.

*(Exact dialog wording varies by Windows build and Defender policy; the
More info → Run anyway shape is the stable part. On a machine with SmartScreen
set to "Block", there is no Run anyway at all and the policy must be changed.)*

☐ **RESULT**: _______________________

---

## 3. Launch

Start Flow from the Start Menu shortcut.

**Expected**:

- The window opens and the renderer mounts.
- **The window has working minimize / maximize / close buttons.** This is
  **B7** — the defect that was not in the original B1–B6 list. `titleBarStyle`
  was unconditionally `'hiddenInset'`, which is macOS-only; on Windows *any*
  non-`default` titleBarStyle removes the standard frame, and without
  `titleBarOverlay` nothing is drawn in its place — a frameless window with **no
  way to close it but Alt+F4**. Windows now gets `'hidden'` +
  `titleBarOverlay`, with a 138px reserve at the right edge of the titlebar so
  app chrome does not slide under the OS-drawn controls.
- Nothing in the app's own UI is drawn underneath those three buttons.

☐ **RESULT**: _______________________

### 3.1 — Menu → Help → About

**Expected**: the About item exists and opens. On macOS this lives in the app
menu, which Windows does not have — before the fix it was **unreachable on
Windows entirely**.

☐ **RESULT**: _______________________

---

## 4. Sign in

Sign in with a Claude account through the app's normal flow.

**Expected**: sign-in completes and the account is persisted.

Then check the credentials file's protection:

```powershell
icacls "$env:USERPROFILE\.flow\credentials.json"
```

**Expected**: inheritance is **disabled** and the **current user is the only
principal**, with full control — the ACL applied by
`app/src/main/platform/file-protection.ts` as
`icacls "<path>" /inheritance:r /grant:r "<user>:(F)"`.

This is **B5**: `chmodSync(0o600)` is a silent no-op on Windows. It returns
successfully and protects nothing — a lie in the shape of a security control.

**If the ACL was not applied**, Windows **warns** rather than throwing (POSIX
still rethrows), and the log names the exposure via `protectionWarning()`.
**A warning here is a finding, not a pass** — record it.

☐ **RESULT**: _______________________
☐ **ACL RESULT**: _______________________

---

## 5. Open a project

Open (or add) a project folder in Flow — a **Windows** checkout, per §1.5.

**Expected**:

- The file tree populates.
- Auto-provisioning scaffolds `.claude/` assets without a terminal.
- No dangling-`flow`-link warning. If the project was ever initialized from
  WSL, you will get the §1.5 message instead — that is the detector working,
  but you need a clean project to continue.

☐ **RESULT**: _______________________

---

## 6. Terminal

Open a terminal pane and run a command that produces output — e.g.
`Get-ChildItem`.

**Expected**:

- A **`powershell.exe`** session spawns via ConPTY, `-NoLogo` (no copyright
  banner), **with** the user's PowerShell profile loaded (the profile is where
  a Windows user's PATH additions live — deliberately *not* `-NoProfile`).
- A full round trip: typed input → executed → ANSI-colored output → prompt
  returns.

> **Already observed** on Windows 11 on 2026-08-14, against a pre-fix build:
> the terminal spawned `powershell.exe` via ConPTY with a complete round trip
> and main-process stderr was empty. Re-confirm it on the packaged build, but
> this step is not where the risk lives.

☐ **RESULT**: _______________________

### 6.1 — Single-command form

Trigger a path that runs **one** command and exits (agent Bash mirroring, or
any single-command terminal invocation) rather than an interactive session.

**Expected**: it runs and exits. PowerShell has **no `-c`** — the POSIX
`[...args, '-c', command]` shape was reused by accident, so the Windows
terminal "worked" only for interactive sessions, which is exactly why nobody
noticed. The single-command form must be `-NoLogo -NonInteractive -Command
<one argument>`, with the command **not** pre-split by the caller.

☐ **RESULT**: _______________________

---

## 7. Agent turn that shells out to `planflow-ai` — **the step that matters**

Start an agent thread in the opened project and ask it to run a `planflow-ai`
verb. Any verb that must actually resolve on `PATH` will do:

```
Run: planflow-ai --version
```

then something with real output:

```
Run: planflow-ai brain search "windows"
```

**Expected**: the command **resolves and runs**. Not "the agent explains that
it cannot"; not a `command not found`.

**This single step is the detector for three separate defects, all of which
fail as missing capability rather than as a crash:**

| Defect | What was wrong | How it surfaces here |
|---|---|---|
| **B1** | `withShimPath` joined PATH entries with a hardcoded `:` and always wrote to a key literally named `PATH`. On Windows the separator is `;`, and the env's own key casing may be `Path`. | The shim directory is either fused into one nonexistent path entry or written to a key nothing reads. `planflow-ai` is not found. |
| **B2** | The shim was written extensionless with a `#!/bin/sh` body. `PATHEXT` is `.COM;.EXE;.BAT;.CMD;…` — an extensionless file resolves to **nothing** for cmd.exe or PowerShell. | Same symptom, different cause. Windows now gets `planflow-ai.cmd` (CRLF, ASCII-only, `exit /b %ERRORLEVEL%` so a failed verb does not report success), and `shimResolutionProblem()` logs loudly if the written shim still would not resolve under `PATHEXT`. |
| **B3** | The SDK's native binary path was hardcoded to `claude-agent-sdk-darwin-arm64/claude`. | The session cannot start at all, or falls back to a bare `claude` on PATH. **Check the log for the fallback warning** — `resolveClaudeBin` warns *whenever* the bare-`claude` PATH fallback is taken. A run that works only because a system-wide `claude` happened to be installed is **not a pass**. |

☐ **`planflow-ai --version` RESULT**: _______________________
☐ **`planflow-ai brain search` RESULT**: _______________________
☐ **Bare-`claude` fallback warning in the log? (yes = FAIL)**: _____________

---

## 8. `blueprint derive`

From the agent thread (or the board), trigger a blueprint derive.

**Expected**: it completes and writes `flow/brain/.structure/graph.json`.

This is **B4**: the derive runner's binary lookup used to include a
`$SHELL || /bin/zsh -lc` login-shell candidate, spawned unconditionally. On
Windows that candidate cannot resolve, and every derive paid a **3-second
timeout** waiting for it. It now returns `null` on win32 **without spawning**.

**So this step is a stopwatch, not just a pass/fail.** Note the elapsed time —
a derive that succeeds but takes ~3s longer than it should means the win32
short-circuit is not being taken.

☐ **RESULT (and elapsed time)**: _______________________

---

## 9. Portable build

Run `Flow-<version>-x64-portable.exe` on a machine where the installer was
**not** run.

**Expected**: it self-extracts to `%TEMP%` and launches — no installer, no
registry writes, no shortcuts. This is the escape hatch for locked-down
machines where even a per-user install is blocked. SmartScreen interposes again
(§2.1); it is a different binary.

☐ **RESULT**: _______________________

---

## Out of scope — do not expect these to work

| | Why |
|---|---|
| **Auto-update** | `win.publish: null`. electron-updater is wired to `latest-mac.yml` only, and an unsigned Windows build cannot be safely auto-updated. Windows updates are a **manual re-download**. |
| **A signed installer** | No Authenticode certificate. §2.1 is the accepted cost. |
| **arm64 Windows** | `win.target` is `arch: [x64]` only. |
| **Linux** | Explicit non-goal. |
| **`npm run release` / `ship` from Windows** | Both **refuse by name** off-macOS. They build, sign, notarize and publish the *macOS* release. (`install:local` is no longer one of them — it builds and silently installs the Windows NSIS artifact; see §1.6.) |

---

## Coverage map

Every step above earns its place; this is which defect each one catches.

| Defect | Caught by |
|---|---|
| B1 — PATH joined with `:`, wrong env key | §7 |
| B2 — extensionless `#!/bin/sh` shim, unresolvable under `PATHEXT` | §7 |
| B3 — hardcoded `darwin-arm64` SDK binary | §1.4 (packaging half) + §7 (runtime half, incl. the fallback warning) |
| B4 — login-shell lookup spawned on win32 | §8 (as elapsed time) |
| B5 — `chmod 0600` is a no-op on Windows | §4 (`icacls` output) |
| B6 — CLI's own `#!/bin/sh` shim rails | §7, via any `planflow-ai` verb reached through the CLI's own rails |
| B7 — `hiddenInset` ⇒ frameless window, no window controls | §3 |

---

## Execution record

Copy this block per run. **Mark every step you did not run as NOT RUN with the
reason.** A checklist reported as executed when it was not launders exactly the
silent-capability-loss failure this whole document exists to prevent.

### Run — 2026-08-16, phase-8 authoring host

**Host**: Windows 11 Pro 10.0.22621, x64. Repo at
`C:\Users\devuser\Projects\plan-flow`, working through WSL for all Node tooling.

| Step | Result |
|---|---|
| §0 Host requirements | **FAIL (host not eligible)** — no Windows `node`, `npm`, or `npx` on PATH; `where cl` does not resolve (no VS Build Tools); `python` resolves only to the `WindowsApps` Microsoft Store alias stub. `git` and `claude.exe` are present. |
| §1.1 Clone and install | **NOT RUN** — no Windows Node/npm. The existing tree was installed under WSL. |
| §1.2 Typecheck and tests | **NOT RUN on Windows.** Run under WSL at the end of Wave 3: root typecheck 0 errors, app typecheck 0 errors, app suite 336 suites / 5039 tests green, root suite green. That is a Linux result and does not substitute for §1.2. |
| §1.3 Package | **NOT RUN.** `electron-builder --win --dir` has been driven to exit 0 from the WSL host, producing a complete `dist/win-unpacked` with `Flow.exe`; the full `--win` run reached `building target=nsis file=dist/Flow-0.1.10-x64-setup.exe archs=x64 oneClick=false perMachine=false` and then failed on `spawn wine ENOENT`. **No installer .exe has ever been produced.** `app/dist/` does not exist on this host. |
| §1.4 Verify packaged binary | **NOT RUN** — nothing packaged, and no Windows Node to run the script. |
| §1.5 Do not reuse a WSL checkout | **CONFIRMED (as a defect condition, on this host).** `Get-Item C:\Users\devuser\Projects\plan-flow\flow -Force` → `Attributes: Archive, ReparsePoint`, `LinkType: []`, `Target: []`; `Test-Path …\flow\discovery` → **False**. This checkout is WSL-owned and cannot be used for §2–§9. |
| §2 Install | **NOT RUN** — no installer exists. |
| §2.1 SmartScreen | **NOT RUN** — no artifact to launch. |
| §3 Launch | **NOT RUN on a packaged build.** A dev build was launched on this host on 2026-08-14, **before** the B7 fix: the renderer mounted and the onboarding wizard rendered and dismissed. The window-controls behaviour that §3 exists to check was not evaluated. |
| §3.1 Help → About | **NOT RUN.** |
| §4 Sign in / ACL | **NOT RUN.** Sign-in was never reached in the 2026-08-14 run. |
| §5 Open a project | **NOT RUN.** |
| §6 Terminal | **PASS, pre-fix dev build, 2026-08-14.** `powershell.exe` spawned via ConPTY with a full round trip — typed input → executed → ANSI-colored output → prompt returned. Main-process stderr was empty. Not re-run against a packaged build. |
| §6.1 Single-command form | **NOT RUN.** |
| §7 Agent turn → `planflow-ai` | **NOT RUN.** The 2026-08-14 run never reached an agent session. **B1, B2, B3 and B6 are therefore unverified on Windows.** |
| §8 `blueprint derive` | **NOT RUN.** B4 unverified on Windows. |
| §9 Portable build | **NOT RUN.** |

**Verdict**: **not verified.** The Windows port is code-complete and green
under WSL, and one pre-fix dev build proved the window and the ConPTY terminal
work on this host. Everything on the agent path — the whole reason this
checklist exists — is untested on Windows. This plan is not done until §1
through §9 have been executed on an eligible Windows machine.

**To make this host eligible**: install Node 22, Visual Studio Build Tools with
the "Desktop development with C++" workload, and a real Python 3; then take a
**separate Windows clone** (§1.5) rather than reusing this one.
