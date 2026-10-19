/**
 * Threads surface composition — `initThreads(surfaces)` is wired by the
 * coordinator after the wave (never self-mounted).
 *
 *   - surfaces.sidebar      ← thread sidebar (grouped, searchable, new-thread)
 *   - surfaces.conversation ← conversation pane (streaming transcript) over
 *                             the composer (input, model selector, interrupt)
 *
 * Selection flows sidebar → pane + composer; live `status` stream events for
 * the selected thread flow pane → composer (Send ↔ Interrupt). threads:updated
 * batches keep the composer's thread snapshot (model/effort/status) fresh.
 */
import '../components'
import type { ShellSurfaces } from '../shell'
import type { BackgroundTaskInfo, ChainState, ThreadSummary } from '../../shared/ipc-contract'
import { subagentRunState, trackerTaskFor } from './background-activity-model'
import { mountBackgroundActivityStrip } from './background-activity-strip'
import { mountChangesStrip } from './changes-strip'
import { Composer } from './composer'
import { ConversationPane } from './conversation-pane'
import { redoFailedToast } from './redo-feedback'
import { resolveThreadSelection } from './thread-selection'
import { createNewThreadPage } from './new-thread-page'
import { askCarryInline } from './carry-menu-view'
import { prepareThreadWorktree } from './prepare-worktree-flow'
import { hasAvailableRoot } from './root-availability-select'
import { ThreadSidebar } from './thread-sidebar'
import { createChainChip } from './chain-chip-view'
import { CLOSE_SUBAGENT_VIEWS_EVENT } from './subagent-open'
import { createThreadProjectChips } from './thread-project-chips'
import { createColumnScrollGuard } from './column-scroll-guard'
import { columnScrollBoxes } from './column-scroll-boxes'

// `editorApi` is gone from this signature: the only thing threads asked the
// editor was whether it held unsaved buffers, for a switch dialog that no
// longer exists. A parameter nothing reads is a claim about a dependency that
// is not there.
export function initThreads(surfaces: ShellSurfaces): void {
  const api = window.flow
  if (!api?.threads || !api?.project) {
    console.warn('flow: preload bridge missing — threads UI disabled')
    return
  }

  // ── Sidebar mount ────────────────────────────────────────────────────────
  const sidebarContainer = document.createElement('div')
  sidebarContainer.style.cssText = 'height:100%;min-height:0;'
  surfaces.sidebar.replaceChildren(sidebarContainer)

  // ── Conversation mount: transcript over composer ─────────────────────────
  const conversationWrap = document.createElement('div')
  conversationWrap.style.cssText =
    'display:flex;flex-direction:column;height:100%;min-height:0;'
  /**
   * THE CONVERSATION'S OWN HEADER — its name, and where its work lands.
   *
   * There was no header here at all, and that is exactly why the branch had to
   * be reported from the status bar: a fact about the conversation on screen
   * was being shown in the one strip of the window that belongs to no
   * conversation. The chip moves it back onto its subject.
   *
   * It is a strip, not a title bar: one line, the same reading column the
   * transcript and the footer cap on (`--fl-conv-column`), and it disappears
   * entirely when there is nothing open — a header over an empty state is
   * chrome announcing itself.
   */
  const conversationHeader = document.createElement('div')
  conversationHeader.style.cssText =
    'flex:none;display:none;padding:var(--fl-space-xs) var(--fl-space-lg) 0;user-select:none;'
  const conversationHeaderRow = document.createElement('div')
  conversationHeaderRow.style.cssText = [
    'display:flex',
    'align-items:center',
    'gap:var(--fl-space-sm)',
    'max-width:var(--fl-conv-column)',
    'margin:0 auto',
    'min-height:22px',
  ].join(';')
  const conversationTitle = document.createElement('span')
  conversationTitle.style.cssText = [
    // The title yields first: a long branch name is identity the reader picked,
    // while the conversation's name is already the row they clicked to get here.
    'flex:0 1 auto',
    'min-width:0',
    'overflow:hidden',
    'text-overflow:ellipsis',
    'white-space:nowrap',
    'font-size:var(--fl-text-ui-size)',
    'font-weight:var(--fl-text-ui-weight-medium)',
    'color:var(--fl-color-text)',
  ].join(';')
  const paneContainer = document.createElement('div')
  paneContainer.style.cssText = 'flex:1;min-height:0;'
  const composerContainer = document.createElement('div')
  // Hidden until a thread is active — a disabled composer under an empty
  // conversation reads as dead/blocked controls. The empty state carries the
  // "New Thread" call-to-action instead.
  composerContainer.style.cssText = 'flex:none;display:none;'
  // The new-thread page takes over THIS column while it is open — it is the
  // same column the conversation it produces will appear in, so starting one is
  // a continuation rather than a jump across the window (user call
  // 2026-09-04). Its siblings are hidden rather than unmounted: the transcript
  // holds scroll position and a live subscription, and tearing those down to
  // ask a question would make coming back a reload.
  const newThreadHost = document.createElement('div')
  newThreadHost.style.cssText = 'flex:1;min-height:0;display:none;'
  // THE REVIEW ITSELF IS NOT IN THIS COLUMN — its ANNOUNCEMENT is, and it now
  // lives in the conversation's own footer row (see `pane.footerSlot`, mounted
  // below once the pane exists) rather than as a full-width band above the
  // composer. The full card shipped here (#1906), between the transcript and
  // the composer, and a thread with four changed files then gave up a band of
  // the reading column permanently and put a scrolling list of files inside a
  // scrolling list of messages. It moved to an editor tab, which fixed that and
  // broke something worse: nothing on screen said a thread had changed
  // anything, so the review was invisible unless you already knew to ask the
  // palette for it.
  //
  // What is left here is one control — `Changes  +1460  −5` — beside the tokens
  // saved chip, on the transcript's own column, opening the Changes tab
  // (`change-review-view.ts`). One control is affordable in a reading column;
  // a file list is not.
  conversationWrap.appendChild(newThreadHost)
  conversationWrap.appendChild(conversationHeader)
  conversationWrap.appendChild(paneContainer)
  conversationWrap.appendChild(composerContainer)
  surfaces.conversation.replaceChildren(conversationWrap)

  // ── Surfaces ─────────────────────────────────────────────────────────────
  const composer = new Composer(composerContainer)
  // The boxes around the column put themselves back at the top if anything
  // scrolls them (column-scroll-guard.ts). Re-read whenever the composer is
  // shown: a layout change can move the column into a different pane.
  const columnScrollGuard = createColumnScrollGuard(
    (line) => void api.diagnostics?.record({ lines: [line] }).catch(() => undefined),
    () => {
      const active = document.activeElement
      return active ? `${active.tagName.toLowerCase()}${active.className ? `.${String(active.className).split(' ')[0]}` : ''}` : ''
    },
  )
  const guardColumnScroll = (): void => {
    columnScrollGuard.watch(columnScrollBoxes(conversationWrap, (el) => el.classList.contains('pane')))
  }
  // The open thread's projects, above the input (Workspaces Phase 9). Inside
  // the composer's own column so it hides and shows with it; invisible unless
  // Workspaces are on and the thread's project is in one.
  const projectChips = createThreadProjectChips()
  composer.setContextSlot(projectChips.element)
  composer.setSkipContextGate((thread) => projectChips.skipGate(thread))

  /**
   * The active runtime's models, read ONCE and given to every picker.
   *
   * There were two of these — one per surface, each doing its own
   * `getDefaultProvider` + `getRuntimeModels` — and two readers of one fact is
   * how two pickers come to disagree: the composer offered Copilot's ids while
   * the new-thread page beside it still showed Claude's aliases (user,
   * 2026-09-16). One read, both surfaces, so they cannot drift
   * (allowed-pattern #14).
   *
   * `models` is what the person pinned (Settings → Models); `suggested` is what
   * Flow found without being told — Codex's rollouts, Copilot's catalogue,
   * Claude's own entitlement list. `candidates` are ids a runtime commonly
   * takes and are passed apart, so a picker can offer them without claiming the
   * account has them.
   *
   * EVERY RUNTIME ASKS, INCLUDING CLAUDE. This used to skip Claude outright,
   * which is why its picker was five hardcoded aliases and a model an account
   * gained never appeared in it.
   */
  function syncRuntimeModels(): void {
    void api.settings
      .getDefaultProvider()
      .then(async (result) => {
        const provider = result.provider ?? 'claude'
        const runtime = await api.settings.getRuntimeModels?.({ provider })
        const extra = [...(runtime?.models ?? []), ...(runtime?.suggested ?? [])]
        const untested = runtime?.candidates ?? []
        // Per-model context-window choices (#1929) — surfaced in the composer's
        // model menu Context row for Copilot.
        composer.setModelProvider(provider, extra, untested, runtime?.contextPreferences ?? {})
        // The page keeps its own copy because it may not be mounted yet; giving
        // it the same answer costs nothing and means opening it never shows a
        // list the composer has already moved past.
        newThreadPage.setRuntimeModels(provider, extra, untested)
      })
      .catch(() => undefined)
  }
  syncRuntimeModels()
  document.addEventListener('flow:runtime-changed', syncRuntimeModels)

  // Recompute the composer's workflow next-step button once a run SETTLES —
  // the suggestion is transient (only shown right after a workflow command
  // finishes), so it is computed here and never on plain thread selection.
  function refreshSuggestion(): void {
    const threadId = selectedThreadId
    if (!threadId) {
      void composer.refreshSuggestion([])
      return
    }
    // The suggestion reads the LAST USER MESSAGE and nothing else, so it asks
    // for a handful. It used to fetch the whole thread detail — 2.74 MB on a
    // real session — after every settled turn, to look at one string.
    void api.messages
      .list({ threadId, limit: 20 })
      .then((messages) => {
        if (threadId === selectedThreadId) void composer.refreshSuggestion(messages)
      })
      .catch(() => undefined)
  }

  const pane = new ConversationPane(paneContainer, {
    onStatus: (threadId, status) => {
      if (threadId === selectedThreadId) {
        composer.setStatus(status)
        // A settled turn may have just run a skill — advance the suggestion.
        if (status !== 'working') refreshSuggestion()
      }
    },
    onNewThread: () => {
      // Reveal the sidebar so the newly created thread is visible (it may be
      // toggled off — otherwise the thread is created but appears nowhere).
      document.dispatchEvent(
        new CustomEvent('flow:reveal-sidebar', { detail: { rail: 'threads' } }),
      )
      void sidebar.createThread()
    },
    onOpenProject: () => {
      void api.project.open().catch((error: unknown) => {
        console.error('flow: failed to open project', error)
      })
    },
  })

  // The Changes control, in the conversation's footer row beside the tokens
  // saved chip — the transcript's own column, not the pane's edge. It hides
  // itself when the thread has changed nothing, and the whole row hides with
  // the transcript, so the new-thread page needs no special case.
  mountChangesStrip(pane.footerSlot)
  // Its sibling: the thread's sub-agent runs (#1931). main dropped this strip
  // (d98bbe86) before the #1931 sub-chat UX settled on it as THE entry point
  // to promoted child threads — the chip, its popover and the e2e DoD (chip
  // persistence, promotion, nesting) all hang off it, so this branch
  // deliberately reinstates it. Hides itself when the thread ran nothing.
  mountBackgroundActivityStrip(pane.footerSlot)

  let selectedThreadId: string | null = null
  // The project whose project surfaces are currently bound (ADR-002).
  let activeProjectRoot: string | null = null

  // ── The active thread's worktree, broadcast once (Phase 6) ──────────────
  // Orientation surfaces — the titlebar's `project · thread · branch`, the
  // terminal strip's root tags — all need the same three facts about the
  // thread on screen: does it have a checkout of its own, what is that
  // checkout, and what branch is it on. This dispatcher already holds the
  // ThreadSummary those come from, so they are announced from here rather than
  // re-fetched per surface (allowed-pattern #14: one source, not four
  // opinions). Surfaces that only scope keep using flow:active-thread and are
  // unaffected.
  interface ThreadWorktreeDetail {
    threadId: string | null
    title: string | null
    /** Absolute checkout path, or null — DATA, never rendered (#12). */
    worktreeRoot: string | null
    branch: string | null
    /**
     * The loop driving this thread, or null when a person is.
     *
     * WHY, NOT ONLY WHETHER. A copy somebody asked for and a copy a loop took
     * because nobody was watching are different facts, and a surface that
     * reported only that a copy exists would make that split harder to follow
     * rather than easier. Already on `ThreadSummary`, so this is one field on a
     * payload that was being built anyway — no new IPC and no second read.
     */
    originLoop: string | null
  }
  let lastWorktree: ThreadWorktreeDetail = {
    threadId: null,
    title: null,
    originLoop: null,
    worktreeRoot: null,
    branch: null,
  }
  /** Announce the thread's worktree — only when something actually changed,
   *  so the hot threads:updated path costs its listeners nothing (#17). */
  function announceThreadWorktree(thread: ThreadSummary | null): void {
    const next: ThreadWorktreeDetail = {
      threadId: thread?.id ?? null,
      title: thread?.title ?? null,
      worktreeRoot: thread?.worktreePath ?? null,
      branch: thread?.worktreeBranch ?? null,
      originLoop: thread?.originLoop ?? null,
    }
    if (
      next.threadId === lastWorktree.threadId &&
      next.title === lastWorktree.title &&
      next.worktreeRoot === lastWorktree.worktreeRoot &&
      next.branch === lastWorktree.branch &&
      next.originLoop === lastWorktree.originLoop
    ) {
      return
    }
    lastWorktree = next
    document.dispatchEvent(
      new CustomEvent<ThreadWorktreeDetail>('flow:thread-worktree', { detail: next }),
    )
  }

  // ── The branch chip, in the conversation's header ────────────────────────
  /**
   * The chip needs one fact this dispatcher does not already hold: the branch
   * the PROJECT itself is on, for the ordinary case where a conversation
   * changes the project's own files.
   *
   * READ ONCE PER PROJECT, NEVER PER REPAINT. `checkout-bar.ts` left this out
   * of the footer altogether rather than pay an IPC on every thread switch
   * (allowed-patterns #17, #19) — the right call for a surface that repaints on
   * every switch, and the wrong answer for a chip whose whole job is to name
   * the branch. Cached per root, it costs one call per project the person
   * actually opens. A root that answers nothing stays null, and the chip says
   * so in words rather than printing a blank.
   */
  const projectBranches = new Map<string, string | null>()
  /** The chip's subject, plus the two things the header needs around it. */
  /** What the conversation header is about. It was the branch chip's subject
   *  until the chip left the header; the title and its project are all that is
   *  drawn here now. */
  type HeaderSubject = { id: string; projectRoot: string; title: string | null }
  /** What the header is currently about, or null when nothing is open. */
  let headerThread: HeaderSubject | null = null
  /** True while the new-thread page has taken this column. */
  let newThreadPageOpen = false

  // ── Autopilot, in the same header row ────────────────────────────────────
  /**
   * WHAT AUTOPILOT IS DOING TO THE CONVERSATION ON SCREEN, and the only way to
   * end it from the app.
   *
   * The driver and its stop both shipped in main with no control anywhere: a
   * person could start a multi-step autonomous run from the board and then
   * neither see which step it was on nor end it. The chip is beside the branch
   * chip because both are properties of the same conversation — one mark on the
   * thread, one press from the thing it changes.
   */
  const chainChip = createChainChip()
  /** What main last said about the header thread's autopilot. */
  let headerChain: ChainState | null = null
  /**
   * The thread whose autopilot has already been asked about.
   *
   * READ ONCE PER CONVERSATION, NEVER PER REPAINT — the sibling of the project
   * branch cache above. `setHeaderThread` is called on every `threads:updated`
   * batch for the open thread, which a streaming turn sends every 50ms; a read
   * per call would be an IPC round trip twenty times a second for a fact that
   * arrives on its own broadcast anyway (allowed-pattern #17).
   */
  let chainReadFor: string | null = null

  conversationHeaderRow.append(conversationTitle, chainChip.element)
  conversationHeader.appendChild(conversationHeaderRow)

  /** Draw the header for whatever is open — or hide it when nothing is. */
  function renderConversationHeader(): void {
    const thread = headerThread
    if (thread === null || newThreadPageOpen) {
      conversationHeader.style.display = 'none'
      chainChip.update(null)
      return
    }
    conversationHeader.style.display = ''
    // The same stand-in the sidebar row uses, so a thread whose first turn has
    // not titled it yet is called one thing in both places.
    const name = thread.title ?? ''
    const shown = name.trim() === '' ? 'Untitled thread' : name
    conversationTitle.textContent = shown
    // The whole name is always reachable, even when the strip shortens it.
    conversationTitle.title = shown
    // A CHAIN BELONGS TO ONE CONVERSATION. Anything held for a different one is
    // not this header's news — drawing it would report another thread's run on
    // the thread in front of the reader.
    chainChip.update(headerChain?.threadId === thread.id ? headerChain : null)
  }

  /**
   * Remember the thread the header is about, and make sure its project's own
   * branch — and its autopilot — have been read at least once.
   */
  function setHeaderThread(thread: ThreadSummary | null): void {
    headerThread = thread === null ? null : headerSubject(thread)
    if (thread === null) {
      headerChain = null
      chainReadFor = null
    } else if (chainReadFor !== thread.id) {
      chainReadFor = thread.id
      // Whatever was held belonged to the conversation being left.
      headerChain = null
      readChain(thread.id)
    }
    if (thread !== null && !projectBranches.has(thread.projectRoot)) {
      // Marked before the answer lands, so a slow read cannot queue a second
      // call per thread switch.
      projectBranches.set(thread.projectRoot, null)
      const root = thread.projectRoot
      void api.threads
        .worktreeBranches({ rootPath: root })
        .then((choices) => {
          projectBranches.set(root, choices.current)
          renderConversationHeader()
        })
        .catch((error: unknown) => {
          // Not knowing is a state the chip can render; it is not an error
          // worth interrupting anybody over.
          console.warn('flow: could not read the project’s branch', error)
        })
    }
    renderConversationHeader()
  }

  /**
   * Ask what this conversation's autopilot is doing — and ONLY ask.
   *
   * The request is sent with no run instruction at all, which the channel
   * defines as a pure read: drawing the state must never be able to start a
   * run. Sending `false` here would end one instead, which is worse than
   * useless on a surface whose whole job is to report.
   */
  function readChain(threadId: string): void {
    const flow = api.flow
    if (flow === undefined || typeof flow.chain !== 'function') return
    void flow
      .chain({ threadId })
      .then((state) => {
        // The reader may have moved on while this was in flight.
        if (headerThread?.id !== state.threadId) return
        headerChain = state
        renderConversationHeader()
      })
      .catch((error: unknown) => {
        // Not knowing is drawn as no chip at all, which is also what most
        // conversations show. Nothing here is worth interrupting anybody over.
        console.warn('flow: could not read this conversation’s autopilot', error)
      })
  }

  // ONE SUBSCRIPTION, FILTERED TO THE CONVERSATION ON SCREEN. Every chain in
  // the app broadcasts here — the board's loop drives one per card it works —
  // and a header that answered all of them would repaint for runs the reader
  // cannot see. Five bugs in this repo have been exactly that
  // (allowed-pattern #17); this is not the sixth.
  if (api.flow !== undefined && typeof api.flow.onChainChanged === 'function') {
    api.flow.onChainChanged((state) => {
      if (headerThread?.id !== state.threadId) return
      headerChain = state
      renderConversationHeader()
    })
  }

  /** The chip's subject: the four facts it reads, plus what the header needs. */
  function headerSubject(thread: ThreadSummary): HeaderSubject {
    return {
      id: thread.id,
      projectRoot: thread.projectRoot,
      title: thread.title,
    }
  }

  // Reflect whether a project is open into the empty-state action ("New
  // Thread" vs "Open Project"), so clicking it never opens a surprise dialog.
  function refreshProjectAvailable(): void {
    void api.project
      .list()
      .then((roots) => pane.setProjectAvailable(hasAvailableRoot(roots)))
      .catch(() => pane.setProjectAvailable(false))
  }
  // A lone UNMOUNTED project must not advertise "New Thread" — only a reachable
  // root counts as "a project is open" (#350).
  api.project.onListChanged((roots) => pane.setProjectAvailable(hasAvailableRoot(roots)))
  refreshProjectAvailable()

  /**
   * The new-thread page (`new-thread-page.ts`), shown in the CHAT column.
   *
   * ONE INSTANCE, reused: the page settles its previous promise with null when
   * it is re-opened, so a caller left waiting on an older ask is never
   * stranded, and asking twice cannot stack two of them.
   */
  const newThreadPage = createNewThreadPage(() => {
    showNewThreadPage(false)
  })
  newThreadHost.appendChild(newThreadPage.element)

  /** Swap the column between the conversation and the new-thread page. */
  function showNewThreadPage(on: boolean): void {
    newThreadHost.style.display = on ? 'flex' : 'none'
    paneContainer.style.display = on ? 'none' : ''
    // The header belongs to the transcript, and goes with it: the new-thread
    // page has no conversation yet to name, and its own branch choice is the
    // composer's (Phase 4), not this strip's.
    newThreadPageOpen = on
    renderConversationHeader()
    // The composer owns its own hidden state (no thread → no composer), so it
    // is only ever hidden from here, never shown: restoring it would put a
    // composer under an empty transcript, which is the state its own rule
    // exists to prevent.
    if (on) composerContainer.style.display = 'none'
  }

  // Editing the model list in Settings, or switching runtime, refreshes the
  // open page — the same cue the composer uses. Nothing to do when it is hidden;
  // it re-syncs on its next open.
  

  const sidebar = new ThreadSidebar(sidebarContainer, {
    // Returned, not fire-and-forget: `#createThread` awaits this so the pane is
    // bound to the new thread before it echoes the first message into it.
    onSelect: (thread) => selectThread(thread),
    /**
     * The first turn of a brand-new thread: BIND, ECHO, SET UP, then send.
     *
     * All four matter and in that order. `selectThread` is awaited because the
     * pane refuses to echo into a thread it is not showing yet (echoUserMessage
     * returns null with no threadId) — and it is exactly that gap the message
     * used to fall through, leaving a fresh thread blank for the whole round
     * trip while the person wondered whether Create had worked.
     *
     * The echo is the composer's own (`pane.echoUserMessage`), so the loader
     * that appears here is the same one every later turn shows.
     */
    startFirstTurn: async (threadId, content, attachments, beforeSend) => {
      const thread = await api.threads.get({ threadId }).catch(() => null)
      if (thread) await selectThread(thread)
      const rollback = pane.echoUserMessage(content, attachments)
      // THE SLOW PART, WITH THE LOADER ALREADY RUNNING. Cutting the thread's own
      // checkout takes seconds, and it used to take them BEFORE any of this — so
      // Create left a blank column for the whole of it and the loader only
      // showed up at the end. The work is the same; what changed is that the
      // person can see it happening.
      if (beforeSend) await beforeSend()
      try {
        await api.threads.sendMessage({
          threadId,
          content,
          ...(attachments.length > 0 ? { attachments } : {}),
        })
      } catch (error) {
        console.error('flow: failed to start the first turn', error)
        // The send never landed — take the echo back rather than leaving a
        // message on screen that no thread holds.
        rollback?.()
      }
    },
    openNewThreadPage: (request) => {
      // Reveal the column first: the page is useless behind a hidden chat, and
      // this is the same funnel every other navigational verb uses (#1071).
      document.dispatchEvent(new CustomEvent('flow:show-chat'))
      showNewThreadPage(true)
      // OPEN, THEN FETCH — not the other way round. Awaiting the commands before
      // opening left the page on screen and unrendered for the whole round trip:
      // visible, wrong, and briefly showing controls it had already retired.
      const answer = newThreadPage.open(request)
      // The active runtime's models, on the same open-then-fetch terms as the
      // reads below: the page opens on a placeholder alias list and learns the
      // provider's real models — including the ids configured for Copilot — once
      // this lands (#1918). Provider is app-level, so it runs whether or not a
      // project is selected.
      syncRuntimeModels()
      // The project's slash commands, fetched HERE because this module owns the
      // project bridge — the page stays DOM-and-state only, so it can be
      // opened in a test with no IPC at all. Fail-soft: a project whose commands
      // cannot be listed still opens a thread, it just has no / menu.
      if (request.primary) {
        const rootPath = request.primary
        void api.project
          .listCommands({ rootPath })
          .then((commands) => newThreadPage.setCommands(commands))
          .catch((error: unknown) =>
            console.warn('flow: listCommands failed for the new-thread page', error),
          )
        // The project's loops, on the same terms and for the same reason: the
        // "keep looking" switch needs to know which loop would run, and asking
        // before opening would hold the page back for the length of the read.
        void api.loops
          ?.read({ rootId: rootPath })
          .then((loops) => newThreadPage.setLoops(loops))
          .catch((error: unknown) =>
            console.warn('flow: loops read failed for the new-thread page', error),
          )
        // The branches this project's threads could begin from — the read-only
        // channel, on the same open-then-fetch terms as the two above. Failing
        // to read them costs the chip its third rung and nothing else: a person
        // can still choose a branch of its own, name it, or work in the project.
        void api.threads
          .worktreeBranches({ rootPath })
          .then((choices) => newThreadPage.setBranches(choices))
          .catch((error: unknown) =>
            console.warn('flow: could not read this project’s branches', error),
          )
        // Where a new conversation begins and whether it may have a checkout of
        // its own — through main's one resolver, never re-derived here. Failing
        // to read them leaves the chip on the built-in start.
        void Promise.resolve()
          .then(() => api.flow.worktreeSettings({ rootId: rootPath }))
          .then(({ settings }) =>
            newThreadPage.setWorktreeDefaults({
              start: settings.worktreeStart.value,
              worktreesAllowed: settings.threadWorktrees.value,
            }),
          )
          .catch((error: unknown) =>
            console.warn('flow: could not read this project’s worktree settings', error),
          )
      }
      return answer
    },
  })

  // NOTE: `flow:open-thread` is handled by the SINGLE guarded listener below
  // (registered after selectThread is defined). A second, unguarded listener
  // here previously double-loaded threads and reloaded the already-open one
  // (#100) — consolidated away.

  async function selectThread(thread: ThreadSummary): Promise<void> {
    // Opening a thread ANSWERS the new-thread question by walking away from it:
    // the column can only show one of the two, and leaving the page up over the
    // transcript would hide the very conversation that was just asked for. The
    // pending ask is settled with null rather than dropped, so #createThread
    // returns instead of waiting forever.
    newThreadPage.cancel()
    // Re-clicking the already-open thread is a no-op — otherwise setThread wipes
    // the feed, drops the pin, and snaps to the bottom, destroying a scrolled-up
    // read / an expanded "Show earlier" chunk. Matches the flow:open-thread guard (#501).
    if (thread.id === selectedThreadId) return
    // NO DIALOG HERE ANY MORE. Opening a thread in another checkout does swap
    // every file on screen, and this used to stop and say so — but the thing it
    // warned about does not happen: `project-context.ts` persists the outgoing
    // root's tabs AND its dirty buffers (#955) and rehydrates them on return,
    // keyed by root, and a thread's checkout is its own root. The dialog's own
    // last line said as much ("They are kept, and come back when you return"),
    // which is the tell: a modal on a routine navigation, to announce that
    // nothing is lost, is a toll every switch pays and teaches the reader to
    // click through. Reported 2026-09-09 — "every time that I'm switching
    // between threads … we should not show this".
    //
    // The unsaved edits stay with the thread that made them, and the tab's
    // dirty dot is the standing signal when you come back to it.
    selectedThreadId = thread.id
    sidebar.setActiveThread(thread.id)
    composer.setThread(thread)
    // #1931 (D-4): a promoted child is locked SYNCHRONOUSLY, before any await.
    // setThread just cleared the per-thread lock, and `syncSubagentGate` below
    // re-asserts it only after its async point read — a reply typed into that
    // window would fork the origin session's conversation. Lock first; the gate
    // then UNLOCKS if the origin already finished. Ordinary threads (no parent/
    // origin) are untouched and stay unlocked.
    if (thread.parentThreadId && thread.originToolCallId) {
      composer.setSendLock(SUBAGENT_SEND_LOCK)
    }
    projectChips.setThread(thread)
    composerContainer.style.display = ''
    guardColumnScroll()
    // Scope decoupled surfaces (the pending-changes review, the git panel's
    // thread-spanning roots) to this thread. `additionalRoots` lets the source
    // control panel show every repo the thread's agent works across (#45).
    // `title` rides along for the surfaces that NAME the conversation rather
    // than merely scoping to it (the board's thread filter, thread-tasklist
    // Phase 4): the id is not a thing to show a person, and a second lookup for
    // a string this dispatcher is already holding would be a second source of
    // the same fact. Listeners that only scope ignore it.
    document.dispatchEvent(
      new CustomEvent<{
        threadId: string | null
        title: string | null
        additionalRoots: string[]
        projectRoot: string | null
      }>('flow:active-thread', {
        detail: {
          threadId: thread.id,
          title: thread.title,
          additionalRoots: thread.additionalRoots,
          // The thread's OWN project: this fires before the project switch a
          // thread in another project causes, so a listener keying anything by
          // (project, thread) — the shell's per-thread layout — must not take
          // the outgoing project for it.
          projectRoot: thread.projectRoot,
        },
      }),
    )
    announceThreadWorktree(thread)
    setHeaderThread(thread)

    // ADR-002: selecting a thread makes its project active. Record the thread
    // as the project's last-active BEFORE switching, so the resulting
    // activeProjectChanged carries this thread (no stale re-select loop).
    void api.project
      .setActiveThread({ rootPath: thread.projectRoot, threadId: thread.id })
      .catch((error: unknown) => console.warn('flow: failed to persist active thread', error))
    if (thread.projectRoot !== activeProjectRoot) {
      activeProjectRoot = thread.projectRoot
      void api.project
        .setActive({ rootPath: thread.projectRoot })
        .catch((error: unknown) => console.error('flow: failed to switch project', error))
    }

    // #1049: pass the thread row's live status so the pane restores the
    // in-progress indication — the same source the composer reads above.
    // #1931: the summary rides along so the pane can show the
    // continuing-from-sub-agent header for a promoted child thread.
    await pane.setThread(thread.id, thread.status, thread)
    // #1931 (D-4): a promoted child thread follows its ORIGIN tool call —
    // armed after the pane settles so the banner note cannot be reset by the
    // thread switch it belongs to.
    if (thread.parentThreadId && thread.originToolCallId) {
      subagentGate = {
        childId: thread.id,
        parentThreadId: thread.parentThreadId,
        originToolCallId: thread.originToolCallId,
      }
      void syncSubagentGate()
    } else {
      clearSubagentGate()
    }
    composer.focus()
  }

  // ── #1931 (D-4): the sub-agent send gate ─────────────────────────────────
  // A promoted sub-agent child thread cannot take a reply while its origin is
  // still running — the origin session owns that conversation until it
  // finishes, and a reply sent now would fork it. ONE resolution drives BOTH
  // surfaces (the composer's lock and the banner's note), so the two can never
  // disagree — and that resolution is the ONE lifecycle merge rule
  // (`subagentRunState`): the BackgroundTaskTracker is the live authority, the
  // persisted tool-call row the fallback. A BACKGROUNDED sub-agent's tool call
  // settles EARLY; keying the lock on the tracker keeps the child locked until
  // the TASK ends, where the old record-only gate unlocked mid-run.
  const SUBAGENT_SEND_LOCK =
    'This sub-agent is still running — replies unlock when it finishes.'
  let subagentGate: {
    childId: string
    parentThreadId: string
    originToolCallId: string
  } | null = null
  let subagentGateToken = 0
  // The tracker's live sets, by thread — fed by the same `background-tasks`
  // stream the sidebar and the activity store already consume, seeded once for
  // work already running when this surface mounted (the stream only carries
  // changes). Replaced whole per event, never merged.
  const subagentLiveTasks = new Map<string, BackgroundTaskInfo[]>()
  void api.threads
    .backgroundTasks?.({})
    .then((byThread) => {
      for (const [threadId, tasks] of Object.entries(byThread)) {
        if (tasks.length > 0 && !subagentLiveTasks.has(threadId)) {
          subagentLiveTasks.set(threadId, tasks)
        }
      }
      if (subagentGate !== null) void syncSubagentGate()
    })
    .catch(() => {})

  function clearSubagentGate(): void {
    subagentGate = null
    subagentGateToken += 1
    composer.setSendLock(null)
    pane.setSubagentOriginRunning(false)
  }

  async function syncSubagentGate(): Promise<void> {
    const gate = subagentGate
    if (gate === null) return
    const token = ++subagentGateToken
    const trackerTasks = subagentLiveTasks.get(gate.parentThreadId) ?? []
    // TRACKER FIRST, no read: a live task claiming the origin keeps the child
    // locked whatever the persisted row says (the backgrounded early-settle).
    if (trackerTaskFor(gate.originToolCallId, trackerTasks) !== undefined) {
      if (selectedThreadId !== gate.childId) return
      composer.setSendLock(SUBAGENT_SEND_LOCK)
      pane.setSubagentOriginRunning(true)
      return
    }
    // FALLBACK — the persisted row decides (app restarts, foreground spawns
    // the tracker never carried). This is the only path that still point-reads.
    const getter = api.toolCalls.get
    if (getter === undefined) return // older preload: no gate, no lock — the old behavior
    let record: Awaited<ReturnType<typeof getter>>
    try {
      record = await getter({
        threadId: gate.parentThreadId,
        toolCallId: gate.originToolCallId,
      })
    } catch (error) {
      // A failed read changes nothing: never lock on one, never unlock on one.
      console.warn('flow: sub-agent gate read failed', error)
      return
    }
    if (token !== subagentGateToken || subagentGate !== gate) return
    if (selectedThreadId !== gate.childId) return
    const { running } = subagentRunState(
      record,
      subagentLiveTasks.get(gate.parentThreadId) ?? [],
      gate.originToolCallId,
    )
    composer.setSendLock(running ? SUBAGENT_SEND_LOCK : null)
    pane.setSubagentOriginRunning(running)
  }

  // The TASK ending arrives on the background-tasks stream — the tracker-side
  // unlock (and lock: a spawn backgrounded mid-watch re-locks). Filtered hard:
  // the map is kept current for every thread (cheap — the runtime sends whole
  // sets on change only), but nothing re-evaluates unless a promoted child is
  // open and its PARENT's set changed.
  api.threads.onStream((event) => {
    if (event.kind !== 'background-tasks') return
    if (event.tasks.length === 0) subagentLiveTasks.delete(event.threadId)
    else subagentLiveTasks.set(event.threadId, event.tasks)
    const gate = subagentGate
    if (gate === null || event.threadId !== gate.parentThreadId) return
    void syncSubagentGate()
  })

  // The origin settling arrives as a tool_call event on the PARENT thread —
  // the FALLBACK-side unlock (foreground spawns the tracker never carried).
  // Filtered hard: nothing is read unless a promoted child is open and its
  // parent's tool calls changed — and even then the tracker short-circuit in
  // syncSubagentGate skips the read while the task is alive.
  api.threads.onUpdated((events) => {
    const gate = subagentGate
    if (gate === null) return
    const touched = events.some(
      (event) => event.threadId === gate.parentThreadId && event.entity === 'tool_call',
    )
    if (!touched) return
    void syncSubagentGate()
  })

  /** Clear the selected-thread state + surfaces and broadcast the null
   *  flow:active-thread signal, so decoupled surfaces (the review reject guard,
   *  #397/#405) never keep a thread from a project that is no longer active.
   *  No-op when nothing is selected. */
  function clearSelectedThread(): void {
    if (selectedThreadId === null) return
    selectedThreadId = null
    clearSubagentGate()
    sidebar.setActiveThread(null)
    composer.setThread(null)
    projectChips.setThread(null)
    composerContainer.style.display = 'none'
    void pane.setThread(null)
    document.dispatchEvent(
      new CustomEvent<{
        threadId: string | null
        title: string | null
        additionalRoots: string[]
        projectRoot: string | null
      }>('flow:active-thread', {
        detail: { threadId: null, title: null, additionalRoots: [], projectRoot: activeProjectRoot },
      }),
    )
    announceThreadWorktree(null)
    setHeaderThread(null)
  }

  // ADR-002: when the active project changes (titlebar switcher, boot restore,
  // or another project's thread), re-select that project's last-active thread —
  // OR clear the selection when the new project has none, so a stale thread from
  // the old project can't drive a reject against the new one (#405). A
  // same-project switch (already selected) is a no-op, so no loop with the
  // setActiveProject call above.
  api.project.onActiveChanged((context) => {
    activeProjectRoot = context?.rootPath ?? null
    // THE CACHED BRANCH IS ONLY GOOD FOR A VISIT. A project's own branch can
    // change from a terminal or another window while Flow is not looking, so
    // the answer is dropped whenever attention returns to a project — one
    // re-read per switch, rather than a subscription to something nothing
    // broadcasts, or a chip that keeps showing the branch you left on.
    if (activeProjectRoot !== null) projectBranches.delete(activeProjectRoot)
    const targetThread = context?.activeThreadId ?? null
    const action = resolveThreadSelection(targetThread, selectedThreadId)
    if (action === 'select' && targetThread) {
      void api.threads
        .get({ threadId: targetThread })
        .then((detail) => {
          if (detail) {
            void selectThread(detail)
            // #1322: guarantee the armed thread has a visible ROW. A collapsed
            // destination group left the user with a live composer bound to a
            // conversation they could not identify.
            void sidebar.revealThread(detail.id)
          } else {
            // The project's recorded active thread was DELETED (dangling
            // pointer) — treat the project as thread-less: clear the stale
            // selection so the review reject guard sees null and refuses to
            // revert, instead of staying armed with the previous project's
            // thread (#411 — the #405 case via the dangling-select path).
            clearSelectedThread()
          }
        })
        .catch((error: unknown) => console.warn('flow: failed to load project thread', error))
    } else if (action === 'clear') {
      clearSelectedThread()
    }
  })

  // #1083: the BOOT activation happens in the main process (project restore →
  // setActiveProject) before this renderer wiring exists, so the change event
  // above never fires for it — the persisted active_thread_id was readable yet
  // read by nobody, and every relaunch landed on an empty chat. Read the
  // initial context directly (the same initial-bind pattern shell/git/kanban/
  // blueprint/review already use — and the exact mechanism of #516, one
  // surface over) and route it through selectThread, so ADR-002 semantics and
  // the #411 dangling-pointer guard come along for free. A change event that
  // beats this read wins: once anything is selected, the restore is a no-op.
  void api.project
    .active()
    .then((context) => {
      if (!context) return
      activeProjectRoot = context.rootPath
      const targetThread = context.activeThreadId ?? null
      if (!targetThread || selectedThreadId) return
      return api.threads.get({ threadId: targetThread }).then((detail) => {
        // Recorded thread since deleted (dangling pointer, #411): nothing is
        // selected at boot, so there is simply nothing to restore or clear.
        if (detail && !selectedThreadId) {
          void selectThread(detail)
        }
      })
    })
    .catch((error: unknown) => {
      console.warn('flow: failed to restore boot thread', error)
    })

  // Keep the composer's snapshot (status/model/effort) in sync with
  // persisted mutations to the selected thread.
  api.threads.onUpdated((events) => {
    if (!selectedThreadId) {
      return
    }
    const touched = events.some(
      (event) => event.threadId === selectedThreadId && event.entity === 'thread',
    )
    if (!touched) {
      return
    }
    void api.threads
      .get({ threadId: selectedThreadId })
      .then((detail) => {
        if (detail && detail.id === selectedThreadId) {
          if (detail.archivedAt !== null) {
            // The OPEN thread was just archived — it folds into the collapsed
            // Archived section and is no longer selectable in the active list, so
            // the conversation + composer must not stay live and bound to a hidden
            // thread the user can still send into. Tear them down like a delete
            // (#686 — the sibling of the #397 delete-the-open-thread teardown).
            clearSelectedThread()
          } else {
            composer.setThread(detail)
            projectChips.setThread(detail)
            // A thread's checkout is DETACHED until its first turn names its
            // branch — this is how the titlebar hears about that without the
            // user re-selecting the thread. Deduped inside, so the batches
            // that change nothing cost their listeners nothing (#17).
            announceThreadWorktree(detail)
            // The chip is how a person sees a branch get its name at the end of
            // the first turn — it reads the same refreshed summary.
            setHeaderThread(detail)
          }
        } else if (!detail && selectedThreadId) {
          // Selected thread was deleted — clear the surfaces + null signal (#397).
          clearSelectedThread()
        }
      })
      .catch((error: unknown) => {
        console.warn('flow: failed to refresh selected thread', error)
      })
  })

  // Optimistic echo: render the user's message the instant they send, before
  // the round-trip resolves, so the pane never sits blank during session spin-up.
  composer.setOnSend((content, attachments) => pane.echoUserMessage(content, attachments))

  /**
   * Settle where this thread's work lands before its first message goes.
   *
   * NO POLICY HERE, AND NO PROTOCOL EITHER ANY MORE. The two-call
   * prepare-then-ask dance and the rule that a dismissal makes nothing both
   * live in `prepare-worktree-flow.ts`, which is also what the sidebar's
   * row-menu action calls — one question, one code path, no way for the two
   * entry points to drift apart (allowed-pattern #14). Everything else is
   * main's: whether this project wants a branch of its own at all, whether the
   * repository can have one, and whether there is uncommitted work worth
   * mentioning.
   *
   * THE QUESTION OPENS ON THE CONVERSATION'S NAME. It used to open on the
   * header's branch chip; that chip is gone, and the question is not. The title
   * is the stable element left in that row — it is written into, never
   * replaced, so a popover anchored to it survives every update — and it sits
   * where the chip did, so the menu still appears at the top of the
   * conversation it is asking about rather than as a modal over the transcript.
   *
   * A clean tree, a thread that already has its own branch, a project that
   * turned this off and a repository that cannot have one all return on the
   * first call, having asked nothing.
   */
  async function prepareWorktree(thread: ThreadSummary): Promise<void> {
    if (thread.worktreePath !== null) return
    if (typeof api.threads.prepareWorktree !== 'function') return
    await prepareThreadWorktree(
      {
        prepare: (request) => api.threads.prepareWorktree(request),
        askCarry: (question) =>
          askCarryInline({ anchor: conversationTitle, watch: conversationTitle }, question),
      },
      { threadId: thread.id },
    )
  }
  composer.setOnPrepareWorktree(prepareWorktree)

  // The one `flow:open-thread` handler — serves every source (Kanban board
  // card, blueprint prompt card, …). Re-opening the already-open thread is a
  // no-op (guard below), and it runs exactly once per dispatch (#100).
  document.addEventListener('flow:open-thread', (event) => {
    const detail = (event as CustomEvent<{ threadId?: string }>).detail
    if (!detail?.threadId) return
    // Reveal the surface the action lands in (#1071): the conversation panel may
    // be hidden (⌘⌥C) — even re-opening the ALREADY-selected thread must surface
    // it, or the click is silently dead. Sibling of flow:reveal-sidebar below.
    if (detail.threadId === selectedThreadId) {
      document.dispatchEvent(new CustomEvent('flow:show-chat'))
      return
    }
    // For ANOTHER thread the reveal waits until it is selected: the panel
    // layout follows the thread, so revealing first would rewrite the layout of
    // the thread being LEFT, and the arriving thread's own layout would then
    // put the chat away again. selectThread announces the switch
    // synchronously, before its first await, so the reveal lands on the
    // arriving thread's layout.
    void api.threads
      .get({ threadId: detail.threadId })
      .then((thread) => {
        if (!thread) return
        void selectThread(thread)
        document.dispatchEvent(new CustomEvent('flow:show-chat'))
        document.dispatchEvent(
          new CustomEvent('flow:reveal-sidebar', { detail: { rail: 'threads' } }),
        )
      })
      .catch((error: unknown) => console.warn('flow: failed to open thread', error))
  })

  // #1931 — promote a sub-agent (a parent Task tool-call) to a real CHILD
  // thread and SWITCH the main pane to it: the sibling of flow:open-thread.
  // The Background activity popover (and the sidebar's sub-agent rows) dispatch
  // this for a persisted sub-agent; the child carries the sub-agent's re-homed
  // transcript and continues as its own resumable session. Replaces the prior
  // right-side progress/sub-chat tab as the primary interaction.
  document.addEventListener('flow:open-subagent-thread', (event) => {
    const detail = (
      event as CustomEvent<{ parentThreadId?: string; toolCallId?: string }>
    ).detail
    if (!detail?.parentThreadId || !detail.toolCallId) return
    const open = api.threads.openSubagent
    if (!open) {
      console.warn('flow: openSubagent IPC unavailable (preload too old)')
      return
    }
    void open({ parentThreadId: detail.parentThreadId, toolCallId: detail.toolCallId })
      .then((thread) => {
        if (!thread) return
        void selectThread(thread)
        // The main pane IS the sub-agent's surface now (D-5): any right-side
        // background-activity / live-progress view — including one opened via
        // the fallback for this very task — closes with the switch, so the same
        // sub-agent is never on screen twice in two different costumes.
        document.dispatchEvent(new CustomEvent(CLOSE_SUBAGENT_VIEWS_EVENT))
        document.dispatchEvent(new CustomEvent('flow:show-chat'))
        document.dispatchEvent(
          new CustomEvent('flow:reveal-sidebar', { detail: { rail: 'threads' } }),
        )
      })
      .catch((error: unknown) =>
        console.warn('flow: failed to open sub-agent thread', error),
      )
  })

  // ⌘P palette "New thread" — reveal the sidebar and create a fresh thread
  // (opening a project first if none is open). Mirrors the sidebar + button.
  document.addEventListener('flow:new-thread', () => {
    // The new thread's conversation must be on screen (#1071) — reveal a
    // ⌘⌥C-hidden chat panel just like the sidebar reveal below.
    document.dispatchEvent(new CustomEvent('flow:show-chat'))
    document.dispatchEvent(
        new CustomEvent('flow:reveal-sidebar', { detail: { rail: 'threads' } }),
      )
    void sidebar.createThread().catch((error: unknown) =>
      console.warn('flow: failed to create thread', error),
    )
  })

  // Seed the composer with a prompt (e.g. a ⌘P slash command like /brainstorm).
  // The composer only exists inside an OPEN thread, so if none is selected we
  // create one first, then prefill once it mounts — otherwise the action was a
  // silent no-op unless a chat happened to be open.
  document.addEventListener('flow:compose-prompt', (event) => {
    const text = (event as CustomEvent<{ text?: unknown }>).detail?.text
    if (typeof text !== 'string' || text.length === 0) return
    // The composer being seeded lives in the conversation panel — reveal it if
    // hidden (⌘⌥C), on BOTH branches (existing thread and create-first), or the
    // slash command prefills into a panel that isn't on screen (#1071).
    document.dispatchEvent(new CustomEvent('flow:show-chat'))
    const prefill = (): void => {
      document.dispatchEvent(new CustomEvent('flow:prefill-composer', { detail: { text } }))
    }
    if (selectedThreadId) {
      prefill()
      return
    }
    document.dispatchEvent(
        new CustomEvent('flow:reveal-sidebar', { detail: { rail: 'threads' } }),
      )
    // NO THREAD YET, SO THE PROMPT GOES ON THE NEW-THREAD PAGE. Creating a
    // thread is a page now (its description IS the first message), so the
    // old "create, then prefill the composer" seeded a hidden, disabled
    // composer while the page sat there empty — the picked command was lost.
    // The page takes the prompt as its description instead.
    void sidebar
      .createThread({ prompt: text })
      .catch((error: unknown) => console.warn('flow: failed to create thread for prompt', error))
  })

  // Review-panel reject → redo: the Review tab reverted a file and asks the
  // active thread's agent to redo it with the user's feedback.
  document.addEventListener('flow:agent-redo', (event) => {
    const detail = (event as CustomEvent<{ filePath?: string; feedback?: string }>).detail
    if (!detail || typeof detail.filePath !== 'string') {
      return
    }
    if (!selectedThreadId) {
      // No thread to receive the redo. Review now refuses to revert in this case
      // (#397); this is the backstop for any other dispatcher — never bail
      // silently, or the user believes a redo was queued when it wasn't.
      document.dispatchEvent(
        new CustomEvent('flow:notify', {
          detail: {
            kind: 'state-change',
            rootId: '',
            title: 'No active thread',
            body: 'Open or select a conversation to request an agent redo.',
            timestamp: new Date().toISOString(),
            level: 'error',
          },
        }),
      )
      return
    }
    const threadId = selectedThreadId
    const filePath = detail.filePath
    const feedback = detail.feedback && detail.feedback.length > 0 ? `: ${detail.feedback}` : '.'
    const content = `I rejected the changes to \`${filePath}\` — please redo them${feedback}`
    const rollback = pane.echoUserMessage(content)
    void api.threads.sendMessage({ threadId, content }).catch((error: unknown) => {
      console.error('flow: agent-redo send failed', error)
      // The send never landed — remove the phantom "please redo" bubble and tell
      // the user, so they don't believe a redo was requested when it wasn't (#180).
      rollback?.()
      const toast = redoFailedToast(filePath, error)
      document.dispatchEvent(
        new CustomEvent('flow:notify', {
          detail: {
            kind: 'state-change',
            rootId: '',
            title: toast.title,
            body: toast.body,
            timestamp: new Date().toISOString(),
            level: toast.level,
          },
        }),
      )
    })
  })

  // Empty state until a thread is selected.
  void pane.setThread(null)
  composer.setThread(null)

  void sidebar.init().catch((error: unknown) => {
    console.error('flow: failed to initialize thread sidebar', error)
  })
}
