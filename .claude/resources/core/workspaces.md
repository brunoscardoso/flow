# Workspaces

## Purpose

A **Workspace** groups projects (a backend, the frontend that calls it, a shared library, …) and owns their knowledge — discoveries, plans, brainstorms, the brain, the archive — plus, in the app, one board, one thread list and one sync. It is one git repository, synced to any host. This file is the skill-facing contract: how an agent finds out whether it is in a Workspace, how it reaches sibling projects' knowledge, and how it records the places where projects touch.

**`flow/` is unchanged as the interface.** In a Workspace project, `<repo>/flow` is a link into the Workspace's project folder instead of the vault. Every skill reads and writes `flow/` exactly as before; nothing in this file changes where a document goes.

**Always on.** Since the hard migration (decision 2026-10-06) every project belongs to a Workspace and every machine has a **Default Workspace** — a LOCAL notion recorded in `<Flow folder>/settings/workspaces.local.json`, never in the synced `workspace.json`. `workspace migrate` puts projects into it and copies their existing knowledge in; per-project knowledge sync (`knowledge enable` / `adopt`) is retired.

**The CLI is the source of truth.** Every Workspace operation — for the terminal, the app and the heartbeat daemon — is a `planflow-ai workspace <action>` verb. No skill, prompt or app code derives a Workspace path or writes a Workspace file itself (allowed-pattern #14).

---

## The Model on Disk

```
<Flow folder>/
├── projects.local.json          project id → this machine's checkout (personal, never synced)
├── settings/
│   └── workspaces.local.json    { "default": "<slug>" } — this machine's Default Workspace (personal)
└── workspaces/<w>/              ONE git repository per Workspace
    ├── workspace.json           { name, slug, remote?, projects: [{ id, name, slug, remotes[], description? }] }
    ├── links.jsonl              cross-project links (append-only; written only by `workspace link-knowledge`)
    ├── merges/                  audit of every merge Flow settled on its own
    └── projects/<p>/            the project's knowledge — what <repo>/flow links to
```

- **Flow folder**: `PLAN_FLOW_HOME` if set; else the parent of `PLAN_FLOW_VAULT_DIR` when that names a `brain` folder (the directory itself otherwise); else `~/plan-flow`.
- **Project identity** is the repo's git remote identity (`host/owner/repo`), never its folder name; a repo with no remote joins as `local:<slug>` and cannot be matched on another machine until it has one.
- **Old knowledge is copied in, never moved or deleted.** With `--import` (what `migrate`, `join` and provisioning use) whatever `<repo>/flow` holds is COPIED into the project folder first — a vault link dereferenced (per-subdirectory links into the project's vault folder included), a plain folder, a committed one, or the project's own knowledge repo without its `.git`. Everything except `.git` and the `generated` class is copied, personal files included (they stay local). A symlink out of the source tree is skipped and listed. Nothing already there is overwritten: same bytes → already there; a clash keeps both — the next free `_v<N>` for a versioned document (its `.walkthrough.html` follows) or `<name>.imported.<ext>` — each listed. Then the original stays as the backup: a vault link is replaced (the vault copy stays), an untracked `flow/` or own knowledge repo is renamed `flow.pre-workspace-<date>/`, and a `flow/` committed in the code repo is renamed `flow.pre-workspace/` in one code-repo commit that is refused until a person has seen it (`--confirm-commit`).

---

## Rules for Skills

### 1. Ask first: `workspace status --target . --json`

```bash
planflow-ai workspace status --target . --json
```

The one lookup. It answers which Workspace and project this repo is and lists the siblings:

| Field | Meaning |
|-------|---------|
| `workspace` | `{ name, slug, path, remote }`, or `null` — **null means no Workspace: skip every Workspace step silently** |
| `project` | this repo: `{ id, name, slug, remotes, description, localPath, flowPath }` |
| `linked` | whether `<repo>/flow` is already the link to `project.flowPath` |
| `siblings[]` | the other projects, same shape — `slug` is what addresses use; `localPath` is null when there is no checkout on this machine |

Never compute a sibling's path yourself; read `flowPath` / `localPath` from here.

### 2. Search siblings with `--scope workspace`

```bash
planflow-ai brain search "<topic>" --scope workspace
```

Searches every project of the Workspace (each sibling's knowledge folder, plus its `CLAUDE.md` and symbols when checked out here), hits namespaced `<project>/…`. The default scope stays this project only, but also surfaces the cross-project `link` hits this project takes part in. Outside a Workspace, `--scope workspace` says so in one line and searches this project. `planflow-ai blueprint context <node>` lists links anchored on a node under `workspaceLinks`. Word queries in the corpus's own vocabulary (`.claude/resources/core/brain-first.md`).

### 3. Record touchpoints with `workspace link-knowledge`

When work touches another project of the Workspace — an endpoint and the screen that calls it, a schema and its consumer, a shared feature — record it as you work:

```bash
planflow-ai workspace link-knowledge --target . \
  --from "<project>/<feature-or-anchor>" --to "<project>/<feature-or-anchor>" \
  --kind calls|exposes|consumes|relates --note "<one line of why/how>" --json
```

**Addresses** — `<project>/<ref>`, split at the FIRST `/` (so file anchors keep their own slashes):

| Part | Accepted |
|------|----------|
| `<project>` | a project slug from `workspace status` (`project.slug`, `siblings[].slug`) |
| `<ref>` — a feature | a bare feature slug, e.g. `backend/orders` |
| `<ref>` — an anchor | `endpoint:<ref>`, `file:<path>`, `module:<path>`, `symbol:<name>`, `table:<name>` — e.g. `backend/endpoint:POST /api/orders`, `frontend/file:src/screens/Checkout.tsx`, `backend/module:src/api` |

Any other `<prefix>:` is refused. Quote addresses that contain spaces.

**Kinds** — `from <kind> to`: `calls`, `exposes`, `consumes`, `relates`.

**Behaviour** — the same `(from, to, kind)` twice is a no-op (`recorded: false`). An anchor end is recorded even when no feature note claims it. Each end that resolves to a feature note (the named feature, or up to 5 features whose anchors cover the anchor) gets a `relates` edge to the other end, written through the feature store; `mirrored[]` reports each one. `--note` is collapsed to one line (300 chars).

**Refusals** — `invalid-link-address`, `unknown-project`, `invalid-link-kind`, `no-workspace`: the JSON payload names the valid project slugs / kinds / anchor kinds. Correct the address from it once, or report the refusal verbatim. `workspace links [--project <slug>] --json` lists what is recorded.

Skills report `Workspace links: N recorded` (zero with its reason). The per-skill steps live in `/brainstorm`, `/discovery-plan`, `/create-plan`, `/execute-plan` and `/review-code`; discovery documents carry a **Related projects in this Workspace** subsection.

### 4. Never hand-edit what a verb or generator owns

| File | Owner |
|------|-------|
| `workspace.json` | `workspace create | link | join | describe | rename | move-project | migrate | set-remote | unset-remote` |
| `settings/workspaces.local.json` | `workspace migrate | set-default` |
| `links.jsonl` | `workspace link-knowledge` |
| `merges/`, the Workspace `.gitignore` / `.gitattributes` | `workspace sync` |
| `projects.local.json` | `workspace link | join | migrate | move-flow-folder` |
| `flow/brain/index.md` | `planflow-ai brain index` — generated from the notes, rebuilt on each machine, never synced |
| the `<repo>/flow` link | `workspace link` (and provisioning, which never moves an existing Workspace link) |

Never run `git` inside a Workspace repo to commit, merge or push its knowledge — that is `workspace sync`, which guards personal files and audits merges.

---

## The CLI Door

| Verb | What it does |
|------|-------------|
| `create --name <n> [--remote <url>]` | new Workspace; the remote is recorded, not contacted |
| `link --target <repo> [--workspace <w>] [--project <id>] [--confirm-commit] [--import]` | add a repo as a project and link its `flow` there; `--project` maps forks, mirrors and remote-less repos onto an existing project; `--import` copies the existing knowledge in first (`imported: { files, skipped[], renamed[{from,to}] }`) |
| `join --remote <url> [--name <folder>]` | clone a Workspace and link every project whose checkout this machine knows |
| `status [--target <repo>] [--workspace <w>]` | the Workspaces here, or which Workspace and project a repo is |
| `link-knowledge --from <a> --to <b> --kind <k> [--note <t>]` | record a cross-project link |
| `links [--project <slug>]` | the recorded links |
| `describe --project <p> --text <t> [--if-empty]` | set a project's description (the context gate reads it) |
| `sync [--workspace <w> \| --all] [--message <m>] [--no-push] [--commit-only] [--resolve <path> --take ours\|theirs\|merged\|file:<path>]` | commit, fetch, merge, push |
| `move-flow-folder --to <dir>` | move `workspaces/`, `settings/`, `projects.local.json`; re-point every `flow` link; later runs need `PLAN_FLOW_HOME=<dir>` |
| `migrate --roots <json> [--name <n>] [--workspace <w>] [--dry-run]` | link every root with `--import` into the Default (created and recorded when missing) or `--workspace`; per root `migrated` / `unchanged` / `pending` (a committed `flow/` waits for `link --confirm-commit --import`) / `failed`; exit 0; `--dry-run` writes nothing and adds `would` + `plan` |
| `rename --workspace <w> --name <n>` | the display name only — the folder never changes |
| `set-default --workspace <w>` | this machine's Default |
| `set-remote --workspace <w> --remote <url> [--replace]` | connect a Workspace to a shared repository after it was created: sets the Workspace repo's `origin` and `remote` in `workspace.json`; contacts nothing — the next `sync` publishes. A different remote already set is refused `remote-exists` (payload `current`, `wanted`, `needs: 'replace'`) unless `--replace`, which drops the old remote's tracking refs and leaves that repository untouched; `sync-busy` / `merge-in-progress` refuse before anything is written |
| `unset-remote --workspace <w>` | disconnect: removes `origin` and `remote`; the Workspace, its history and the shared repository are untouched (`remoteUntouched: true`); `sync` is `local-only` again |
| `move-project --project <p> --to <w> [--from <w>]` | move a project's knowledge folder, both `workspace.json` files and every checkout's `flow` link |
| `delete --workspace <w> --confirm` | move its projects into the Default and keep the folder as `workspaces/.deleted-<slug>-<date>/`; the remote is untouched; never the Default |

All take `--json`. A refusal prints a JSON payload line on stdout, then `workspace refused: <reason> — <sentence>`, exit 1; callers read the last parseable JSON line. Remotes are `https://`, `ssh://` or scp-style, never with credentials.

---

## Sync

**Four classes** (one table, `src/cli/handlers/knowledge-classes.ts`):

| Class | Examples | Travels |
|-------|----------|---------|
| generated | `brain/index.md`, `.derived/`, derived `.structure/` files, `*.run.json` | never — rebuilt on each machine |
| append-only | `*.jsonl` stores, `links.jsonl` | synced, merged by union |
| personal | `.flowconfig`, `.rounds.jsonl` (live), `STATE.md`, `.scratchpad.md`, `tasklist.md`, `memory.md`, `log.md`, `heartbeat.md`, `brain/.raw/`, learning state | never — git-ignored, and the pre-push guard refuses the whole sync (`personal-files`) if one is staged or unpushed |
| authored | discoveries, plans, brainstorms, decisions, feature notes, the archive | synced with git's line merge |

**Merges.** Flow settles only safe cases on its own — union of `*.jsonl`, the same new versioned document on both sides (ours renumbered to the next free version, references updated), non-conflicting `workspace.json` changes, clean line merges — and writes each to `merges/`. A decision note touched on both sides, the same feature edited on both sides, two features newly claiming one anchor, or one discovery changed on both sides where an existing version was edited is an **ask**; any other conflict is a **review** (both versions and the base handed back for a drafted merge). Either aborts the merge, pushes nothing, and is a result (exit 0), decided with `--resolve <path> --take …`. A shared repository whose history has nothing in common with the Workspace's (another Workspace, a repository started by hand) is refused `unrelated-history` before anything is merged or pushed — connect an empty repository, or `join` the one it holds. Never a force push. States: `synced`, `local-only`, `nothing-to-do`, `committed`, `ask`, `review`, `behind`, `offline`, `no-access`.

Per-project knowledge sync is retired: a project whose checkout kept its own knowledge repository (a real `flow/` with its own `.git`) is migrated into its Workspace with `--import`, never skipped. `knowledge status` still answers (with `retired: true`) and `knowledge disable` still unhooks an old repo; `knowledge enable` / `adopt` refuse `retired`.

---

## The App Side

MOVED HERE FROM `CLAUDE.md` (#1949), where this file's own See Also used to
send the reader. The always-loaded file paid ~4,370 tokens per session and per
sub-agent for it — the single largest section in it — and pointed here anyway.

**First-prompt context gate** (`app/src/main/agent/context-gate.ts`). On the first send of a thread in a Workspace with no hand-picked projects, the fast model (haiku) reads the message and the projects' descriptions and the chosen projects are **attached before the session starts** (a session's folders are fixed at spawn), shown as chips. The thread's own project always stays primary; only projects with a checkout on this machine are eligible; a timeout (6 s), error or invalid answer leaves the thread in its own project. Later sends can only **offer** one more project — after the first turn only a person attaches or removes one, taking effect on the next turn. A project with no description is described once (`describe --if-empty`).

**Connections learning** (discovery `workspace-connections-learning`, 2026-10-06). A Workspace learns how its projects talk, one PAIR of projects at a time — its own kind of learning, separate from a project's. `planflow-ai workspace learn-connections [--target <repo>] --json` is the plan (writes nothing): every pair `learned | pending | blocked` (pending = never checked, or either project's fingerprint — its features and anchors, the endpoints it serves, the calls it makes — changed since; blocked = a project has no features yet), its signs of talking and, for a pending pair with a sign, the **dossier** — the whole prompt for the fast model, with settings reduced to host names. `--pair <a>,<b> [--answer <file> | --model no-signal|unavailable|failed]` checks one pair: the federation matcher's conclusive matches (`cross-links.ts` `autoConfirmable`; a match a person rejected stays rejected) are written grouped by feature, the model's answer is checked against the real features (invented slugs, one project on both ends, a project outside the pair, an unknown kind → dropped and counted; ≤ 12 per pair) and written, all through `linkKnowledge` marked `source: 'learned'` + `evidence: code | model`, and the check is appended to `<workspace>/connections-learning.jsonl` (append-only, union-merged — a teammate's check counts). A failed model call keeps the code matches and leaves the pair pending. The app's half (`app/src/main/workspaces/connections-learner.ts`) runs one queue per Workspace — automatically when a project finishes basic discovery and once ~90 s after launch, by a person from **Learn connections** on the Workspace map — asks the fast model only for pairs with a dossier, and broadcasts `workspaces:connectionsLearning` once per pair. The map's strip says `N of M pairs checked`; a connection only the model vouches for is drawn with finer dashes and named "suggested by Flow". Not yet: a learned connection the code stops making is not retracted.

**One colour per project, everywhere** (2026-10-06). The Workspace map's eight hues are the app's project palette (`--fl-project-hue-0..7` in `theme/tokens.css`, a lifted value for dark and a darkened one for light; the board's `--fb-ws-hue-N` refer to them). A project's colour is, in order: the one picked in its settings (**Colour**, persisted as `accent_color` via `project:setRootAccent`; a pick from the retired pastel set maps to its family), its position in its Workspace (`project-accent-workspaces.ts` records the slots), the hash of its path. Everything paints through `ensureAccentProperty` (`renderer/project-accent.ts`) — the file tree's bar, tabs, git groups, the switcher's folders and the map — so a pick repaints them all at once. On the map the colour is one mark — a bar at the start of each project's header; borders and cells stay neutral.

**Connecting a shared repository in the app.** Settings → Workspaces: a card with no shared repository shows **Connect a shared repository…** where Sync now would be (a Workspace with nothing to sync with has no Sync now); a connected one shows the address with **Change…** and **Disconnect…**. The dialog offers **Create one on GitHub / Azure DevOps** — only for hosts whose own CLI (`gh`, `az` + DevOps extension) is signed in on this computer, with owner / organization + project pickers and a suggested `<workspace-slug>-knowledge` name, always PRIVATE, Flow holding no credential — or **Use an existing repository** on any git host by its address (checked live with `app/src/shared/git-remote.ts`). Main (`app/src/main/workspaces/workspace-remote.ts` over the restored `host-tools.ts`) creates the repository if asked, calls the CLI's `set-remote` / `unset-remote` through the registry, then runs one sync and answers its status. Channels: `workspaces:hostTools`, `workspaces:createRemote`, `workspaces:setRemote`, `workspaces:unsetRemote`. Onboarding's Workspace step offers the same dialog as an optional **Share with your team…**. Under `FLOW_E2E=1` every host tool answers "not installed", so no test ever reaches a real `gh`/`az`.

---

## How Workspaces Became the Only Mode

**Always on — the hard migration** (decision 2026-10-06, `flow/brain/decisions/workspaces-hard-migration.md`). There is no switch: every project belongs to a Workspace, and every machine has a **Default Workspace** that `workspace migrate` puts projects into. The Default is a LOCAL notion — recorded in `<Flow folder>/settings/workspaces.local.json` (`{ "default": "<slug>" }`), never in the synced `workspace.json`, because two teammates sharing a Workspace each have their own Default. Existing knowledge is COPIED in (`link --import`): whatever `<repo>/flow` is — a vault link (dereferenced, including per-subdirectory links into the vault project folder), a plain folder, a committed folder, or the project's own knowledge repo (`.git` never copied) — everything but `.git` and the `generated` sync class is copied (personal files too; the Workspace `.gitignore` keeps them local), a symlink out of the source tree is skipped and listed, and nothing already in the project folder is overwritten: a clash keeps both, the incoming file under the next free `_v<N>` for a versioned document (its walkthrough follows) or `<name>.imported.<ext>` otherwise, each listed (`src/cli/handlers/workspace-import.ts`). Per-project knowledge sync is **retired**: `knowledge enable`/`adopt` refuse `retired`, `knowledge status` adds `retired: true`, `knowledge disable` still unhooks an old repo.

**App gating.** None any more: Workspaces are always on (decision 2026-10-06 — no `workspaces_enabled` setting, no `FLOW_WORKSPACES`, no classic sidebar). There is **no schema change**: membership is derived from the CLI (a thread's Workspace is its primary project's, a task's its `project_root`'s), the few app-only facts live in app-settings rows, and the physical table names kept by the project rename (`app/src/main/store/storage-names.ts`) stay — so the dev app and the installed app keep sharing one profile.

---

## The Flow Folder on Disk

**On disk.** `<Flow folder>/workspaces/<w>/` is the repository: `workspace.json` (`name`, `slug`, `remote?`, `projects: [{ id, name, slug, remotes[], description? }]`), `projects/<p>/` (what `<repo>/flow` links to), `links.jsonl` and `merges/`. Beside it, `projects.local.json` maps project id → this machine's checkout and is personal (never synced). The **Flow folder** resolves `PLAN_FLOW_HOME` → the parent of `PLAN_FLOW_VAULT_DIR` (when that names a `brain` folder) → `~/plan-flow` (`resolveFlowFolder`, `src/cli/utils/files.ts`). A project's id is its git remote identity (`host/owner/repo`), never its folder name; a repo with no remote joins as `local:<slug>`. Old knowledge is never moved or deleted — with `--import` it is copied in first, and the original stays as the backup: linking replaces a vault link (the vault copy stays), renames an untracked `flow/` — or one that is its own knowledge repo — to `flow.pre-workspace-<date>/`, and renames a committed `flow/` to `flow.pre-workspace/` in one code-repo commit that is refused until a person has seen it. Provisioning links a repo that is a project of exactly one Workspace there (only on this machine's own `projects.local.json` record — a remote match is a suggestion), importing what `flow/` held, never into the vault, and never moves an existing Workspace link. `init --workspace-managed` (what the app passes) leaves a `flow/` that is not a Workspace link exactly as it is — no vault link, no vault registration, nothing seeded — because the app runs `workspace migrate` for every project right after; a terminal `init` without the flag behaves as before. The old `PLANFLOW_WORKSPACES` environment switch is ignored.

**Not supported yet**: taking a project out of every Workspace (a project always belongs to one — `move-project` moves it between them), and moving the Flow folder from the app (the CLI's `move-flow-folder` exists; the app shows the folder read-only and says so).


---

## See Also

- `.claude/resources/core/brain-first.md` — search-first retrieval, including `--scope workspace`
- `.claude/resources/core/brain-capture.md` — the generated brain index
- `flow/brain/decisions/workspaces-hard-migration.md` — why Workspaces are the only mode
