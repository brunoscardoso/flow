# What was slow, and what it costs now

Every number here came from a probe in this directory (`npm run perf -w app`)
or from `e2e/perf/` (`npx playwright test e2e/perf/`), on the same machine,
against real projects — a 4,182-file repo and this one. Both figures are kept
for every change: a claim with one number is a hope.

## The headline

Adding this repository as a project — the busiest minute the app has:

| | before | after |
|---|---|---|
| main process on CPU | 28,000ms | 795ms |
| …of that, inside `posix_spawn` | ~26,000ms | 163ms |
| git processes spawned | 1,145 per 10s | 123 per 11s |
| longest recorded main stall | 10,719ms | none |

The app was not doing 28 seconds of work. It was doing 28 seconds of
*forking* — on the one thread every window waits behind.

## Per surface

| what | before | after | how |
|---|---|---|---|
| `git:mergeState` | 159ms | 17ms | ask the index (`ls-files -u`), not the whole working tree |
| 3 × `git:status` at once | 432ms | 143ms | one scan, shared by concurrent callers |
| `status` + `review:list` | 285ms | 141ms | review rides the same scan |
| `threads:get` | 1,306 KB / 14ms | 0.4 KB / 0.04ms | a thread read is a summary, not a transcript |
| opening an 1,800-call thread | 3,194 KB / 38ms | 840 KB / 6ms | fetch the window the pane mounts |
| `blueprint:read` (this repo) | 5,695ms | not slow enough to log | never wait for a drift assembly |
| `loops:read` at startup | 2 × 2,000ms | not read at all | nobody had opened the panel |
| main's read behind a bounded tool-call list | 6.51 MB | 2.29 MB | bound in the query, not after it |
| the federation evidence join (200×2,000) | 202ms | 17ms | split a path once, not per comparison |
| the working-set capture, per turn | 1.69 MB | 33.5 KB | read the path, not the file it wrote |
| the palette's source, per keystroke | 297 KB | 0 | fetch the list once per palette |
| the board's ten files, per refresh | re-read | stat + memory | read-through cache keyed on size+mtime |
| the pane's story read | the whole snapshot (1.1 MB graph) | one small file | a channel that answers the question asked |

## What was measured and found INNOCENT

Worth as much as the finds, because each one had been suspected:

- **The stream bridge.** A 200-tool turn — 9,200 SDK messages, persisted and
  broadcast — costs main 34ms end to end.
- **The renderer.** A keystroke lands in 20–27ms with an 1,800-call thread
  mounted, while 400 writes stream in, and while 1,500 files are rewritten
  under the watcher.
- **Idle.** 51ms of CPU across 60 seconds with a project open; 76ms with five.
- **Leaks.** Forty rounds of switching threads and flipping panels: renderer
  heap flat, DOM flat, thread switch 46ms → 34ms.
- **A flooding terminal.** 40,000 lines of output arrive as 1,006 events and
  0.45 MB, cost main 61ms, and a keystroke made in the middle of it lands in
  23ms (15ms with the terminal quiet).
- **Bootstrap.** 66ms, itemised (database 11ms, IPC handlers 52ms). The 417ms
  from launch to a window is Chromium and the renderer bundle.
- **The learner's machinery.** 365 modules drain in 6.7s with the model stubbed
  — 18ms each for the queue, two state rewrites and the events. (A first run of
  this probe reported 12 SECONDS per module; the probe was wrong — the session
  budget had dropped every module after the tenth and it was timing its own
  wait. The number above is from the fixed one.)

## Two things that were wrong in a different way

Not slow — WRONG, and found while measuring:

- **A batch that never flushed.** Thread and task changes broadcast on a 50ms
  debounce, and a debounce resets on every event: a stream that never pauses for
  50ms never sends. While an agent worked hardest, the sidebar and composer were
  told nothing at all, then everything at once. It now also flushes 250ms after
  the first event it is holding.
- **A `git pull` bounded by a local patience budget.** Routing git through the
  helper meant giving it a timeout where `execFile` had none. Two minutes is
  right for a hung local command and wrong for a pull over a slow link; network
  verbs now get six hours.

## Where it ends up

On a copy of the reporter's own profile — four real projects, 122 threads,
21,745 messages, 5,509 tool calls:

| | |
|---|---|
| launch → window | 435ms |
| launch → a thread list | 639ms |
| open the 1,789-call thread | 32ms (416 KB across IPC) |
| keystroke → on screen | 22ms |
| switch project | 60–87ms |

Startup itself is now mostly Chromium: `bootstrap 62ms — database 12ms, ipc
handlers 47ms, …` and `renderer startup: script 74ms, shell 3ms, first paint
109ms` out of ~450ms to a window. There is no 10× left in that number; the 10×
was in the stalls, and those are gone.

## Verification

The git work is deep — every command in the app now spawns from the helper
process — so it was checked against the whole git e2e suite rather than a
sample: **57 passed, 0 failed, 3 skipped** (11.7 minutes, on the final build),
covering staging,
committing, discarding, merge and rebase recovery, submodules, and the
untracked-folder rollup. Small ad-hoc groups of those specs flake against each
other; the full sweep does not.

Unit tests: **6,225 pass**, one red — `claude-import`, which reads the real
`~/.claude` and was already failing before this branch.

The wider `e2e/ux` suite has substantial failures in this environment, and they
are NOT from this work: every family sampled (blueprint, composer history, app
menu, editor menu, artifact cards, conversation states) fails identically on
`main` with a fresh build of `main`'s own source. One example with a named
cause: the blueprint specs expect a header button reading "Open Project" where
the board now says "Code map" — a change that landed on main on 2026-08-18
(#1718). Worth someone's attention; it is not this branch's.

## The instruments

They stay, because every round of this has started by rebuilding them.

- `perf/*.probe.ts` — store, blueprint, agent-turn costs (`npm run perf -w app`).
- `e2e/perf/*.perf.spec.ts` — startup, channels, thread open, streaming, soak,
  file churn, board, and a V8 CPU profile of the main process.
- In the app itself: a slow-handler log, an event-loop stall watcher, renderer
  long-task and interaction records, a git spawn census, a CLI run timer, and
  a bootstrap breakdown — all in one file, reachable from Help ▸ Copy
  Performance Report.
