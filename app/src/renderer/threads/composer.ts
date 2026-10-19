/**
 * Composer — the message input at the bottom of the conversation pane.
 *
 *   - cmd/ctrl+Enter sends (threads:sendMessage); Enter inserts a newline
 *   - @-file mentions: typing `@` opens a path autocomplete fed lazily by
 *     project:listDir against the thread's project root (one directory
 *     level per fetch, cached until thread switch)
 *   - slash commands pass through as plain text — plan-flow skills run
 *     inside the agent session, the app does not intercept them
 *   - model/effort selector: Auto (plan-flow routing, sent as
 *     {model:'auto'}) or a concrete Claude model + effort low/medium/high
 *     → threads:setModel
 *   - interrupt button replaces Send while the thread status is `working`
 *     (threads:interrupt)
 *   - blueprint reference chips (Board→Chat): the Blueprint board's attach
 *     affordance dispatches `flow:blueprint-selected` on document; the
 *     composer renders each reference as a dismissible pill above the input
 *     and, on send, folds them into the message CONTENT via serializeChips
 *     (renderer-only — the sendMessage IPC shape is untouched)
 */
import { publishCommandNames } from './command-names'
import { ComposerHighlight } from './composer-highlight'
import { renderHighlightedText } from './message-token-view'
import '../components'
import type {
  DirectoryEntry,
  EffortLevel,
  SlashCommand,
  ThreadScope,
  ThreadStatus,
  ThreadSummary,
} from '../../shared/ipc-contract'
import { ensureAccentProperty } from '../project-accent'
import { currentPlatform, isCaptureAffordanceVisible } from '../platform-affordances'
import { switchDiscardNotice } from './switch-discard-notice'
import { mentionTrigger, quoteMentionPath } from './mention-quoting'
import {
  mentionInsertionPath,
  mentionListRequests,
  mentionRoots,
  mergeMentionMatches,
  type ScopedMentionItem,
} from './mention-scope'
import {
  addChip,
  clearChips,
  dismissChip,
  serializeChips,
  type BlueprintChipRef,
} from './composer-chips'
import {
  addContextChip,
  contextChipPreview,
  contextChipId,
  dismissContextChip,
  serializeContextChips,
  type ContextChipRef,
} from './context-chips'
import {
  addAttachmentWithOutcome,
  attachmentDataUrl,
  removeAttachment,
} from './attachment-chips'
import {
  attachmentId,
  MAX_ATTACHMENTS_PER_MESSAGE,
  validateAttachment,
} from './image-attachment'
import type { MessageAttachmentInput, RuntimeContextChoice } from '../../shared/ipc-contract'
import { attachedWhileHiddenToast } from './attach-feedback'
import { harSummaryText, readHar } from '../../shared/har-summary'
import {
  classifyAttachment,
  rejectReasonMessage,
  type AttachClass,
  type AttachRejectReason,
} from './text-file-attach'
import {
  DRAFT_STORE_KEY,
  draftFor,
  parseDraftStore,
  serializeDraftStore,
  withDraft,
} from './composer-draft'
import {
  caretOnFirstLine,
  caretOnLastLine,
  emptyHistory,
  navigate,
  pushEntry,
  recallableText,
  RECALL_SEED_MESSAGE_LIMIT,
  resetNavigation,
  seedEntries,
  type ComposerHistory,
} from './composer-history'
import { computeNextStepCommand } from './workflow-suggestion'
import { modelLabel } from './model-label'
import { modelOptionsFor, type RuntimeModelOption } from '../../shared/runtime-models'
import { buildModelOptions } from './model-options'
import { effortControlState } from './effort-control'
import { computeCommandInsertion } from './command-insertion'
import { composedPromptFor, composedSendRoute, hasSendableContent } from './composer-send'
import {
  dequeue,
  enqueuePrompt,
  moveToFront,
  queuePreview,
  queuedRestore,
  removeQueued,
  shouldAutoDrainOnStatus,
  sendNowFlagTransition,
  type QueuedPrompt,
  isComposerFreeStatus,
} from './prompt-queue'
import { enterKeyIntent } from './composer-keys'
import { createModelEffortMenu, type ModelEffortMenu } from './model-effort-menu'
import { sendFailedToast } from './redo-feedback'

// The model list belongs to the RUNTIME (shared/runtime-models.ts). This file
// used to hold Opus / Sonnet / Haiku unconditionally, and the thread handed the
// choice straight to whatever CLI was running: picking Copilot and sending a
// message produced `--model opus`, which Copilot rejects, and a chat that did
// nothing at all.

const EFFORT_OPTIONS: ReadonlyArray<EffortLevel> = ['low', 'medium', 'high']
const DEFAULT_EFFORT: EffortLevel = 'medium'
/** Slash commands are only valid as the first token of a message, so the
 *  trigger anchors to the start of the input: `/` then the partial name. */
const COMMAND_RE = /^\/([\w-]*)$/
const MAX_MENTION_RESULTS = 10
const MAX_COMMAND_RESULTS = 12
/** Debounce for the input-driven per-thread draft save (#1067). */
const DRAFT_SAVE_DEBOUNCE_MS = 400
/** Taller default input — the composer opens at a few lines and grows further. */
const MIN_TEXTAREA_HEIGHT_PX = 76
const MAX_TEXTAREA_HEIGHT_PX = 260

export class Composer {
  #textarea: HTMLTextAreaElement
  #highlight: ComposerHighlight
  #sendButton: HTMLElement
  #sendLabel: HTMLSpanElement
  #sendSpinner: HTMLElement
  #sendMode: 'send' | 'pending' = 'send'
  #interruptButton: HTMLElement
  #modelSelect: HTMLSelectElement

  /** Which runtime's models the picker is currently offering. */
  #modelProvider = 'claude'

  /** The saved context-window choice per model id (#1929) — surfaced in the
   *  model menu's Context row for Copilot. Keyed by model id; a missing entry
   *  means the model's default window. */
  #modelContext: Record<string, RuntimeContextChoice> = {}

  /** Provider + list, so a repaint only happens when the menu really changed. */
  #modelSignature = ''

  /** What the picker currently offers — the runtime's, plus the user's. */
  #modelOptions: readonly RuntimeModelOption[] = modelOptionsFor('claude')
  #effortSelect: HTMLSelectElement
  /** Live "using <model>" indicator — the SDK-resolved model, shown while the
   *  turn is working (accurate even when the thread is set to 'auto') (#129). */
  #modelIndicator: HTMLSpanElement
  #activeModel: string | null = null
  #suggestionBar: HTMLDivElement
  #suggestionButton: HTMLButtonElement
  #nextStep: SlashCommand | null = null
  #mentionPopup: HTMLDivElement
  #commandPopup: HTMLDivElement
  #thread: ThreadSummary | null = null
  /** Autopilot for THIS thread's project, as last broadcast by flow/index.ts. */
  #autopilot = false
  #autopilotButton!: HTMLButtonElement
  /** The model+effort popover — a view over the two selects above. */
  #modelEffort!: ModelEffortMenu
  #status: ThreadStatus = 'idle'
  #sending = false
  /** #1931: non-null while sending is LOCKED — a promoted sub-agent child
   *  thread whose origin tool call is still running cannot take a reply (the
   *  origin session owns the sub-agent's conversation until it finishes). The
   *  string is the reason, shown on the disabled input; the banner above the
   *  feed says the same thing in full. */
  #sendLock: string | null = null
  /** Set when the user clicks "Send now" on a queued prompt mid-turn (#524): the
   *  running turn is interrupted and the jumped-to-front prompt drains on the exit
   *  from `working`. Distinguishes this deliberate interrupt from the stop button,
   *  which must never drain the queue (#490). Cleared once the drain fires. */
  #pendingSendNow = false
  /** Fired optimistically the instant a send is accepted, so the pane can
   *  echo the user's message before the round-trip resolves. */
  /** Optimistic echo; returns a rollback that removes the bubble + stops the
   *  loader, called if the send then fails (#279). */
  #onSend:
    | ((content: string, attachments: readonly MessageAttachmentInput[]) => (() => void) | null)
    | null = null
  /**
   * Settle the thread's own worktree before its first message goes
   * (thread-worktrees Phase 5). Awaited immediately before `sendMessage`,
   * because the session's root is fixed at spawn and no later creation moves
   * it; it is also the only surface that can put the uncommitted-work question
   * on screen, which `sendMessage` itself cannot.
   *
   * Absent → nothing happens and every send is byte-identical to before.
   */
  #onPrepareWorktree: ((thread: ThreadSummary) => Promise<void>) | null = null
  /** Whether a send should skip the Workspace context gate (Workspaces Phase 9). Absent → never. */
  #skipContextGate: ((thread: ThreadSummary) => boolean) | null = null
  /** Lazy per-directory listing cache for the current thread's root. */
  #dirCache = new Map<string, DirectoryEntry[]>()
  #mentionItems: ScopedMentionItem[] = []
  #mentionSelected = 0
  /** Active thread scope (multi-project threads Phase 6) — @-mentions search
   *  every attached root. Null until the scope layer delivers (fail-soft:
   *  mention search then uses the thread's primary root, exactly as today). */
  #scope: ThreadScope | null = null
  /** Range of the active @query inside the textarea value. */
  #mentionRange: { start: number; end: number } | null = null
  /** Slash commands for the current thread's project (lazy, cached). */
  #commands: SlashCommand[] | null = null
  #commandItems: SlashCommand[] = []
  #commandSelected = 0
  /** Range of the active /query inside the textarea value. */
  #commandRange: { start: number; end: number } | null = null
  /** Attached blueprint references (Board→Chat), in insertion order. */
  #chips: readonly BlueprintChipRef[] = []
  /** Context selections attached via cmd+L (terminal/file) — #152. */
  #contextChips: readonly ContextChipRef[] = []
  /** Pending image attachments (paste/drag/picker/capture) — #456. */
  #attachments: readonly MessageAttachmentInput[] = []
  #shell: HTMLDivElement | null = null
  #chipBar: HTMLDivElement
  /** Prompts queued while the agent is working — auto-sent FIFO on turn end (#472). */
  #queue: readonly QueuedPrompt[] = []
  #queueBar: HTMLDivElement
  /** The composer's root element — the focus-ownership boundary (#1045). */
  #container: HTMLElement

  constructor(container: HTMLElement) {
    injectComposerStyles()
    container.classList.add('fl-composer')
    this.#container = container

    // ── Next-step suggestion bar (workflow-aware) ────────────────────────
    // Sits above the input; a single button proposes the next skill in the
    // plan-flow flow (e.g. /discovery-plan after /brainstorm). Hidden unless
    // there is a suggestion and the thread is idle.
    this.#suggestionBar = document.createElement('div')
    this.#suggestionBar.className = 'fl-composer-suggestion'
    this.#suggestionBar.hidden = true
    this.#suggestionButton = document.createElement('button')
    this.#suggestionButton.type = 'button'
    this.#suggestionButton.className = 'fl-composer-suggestion-btn'
    this.#suggestionButton.addEventListener('click', () => this.#acceptNextStep())
    this.#suggestionBar.appendChild(this.#suggestionButton)

    // ── Blueprint reference chips (Board→Chat) ───────────────────────────
    // Dismissible pills above the textarea. Fed by the document-level
    // `flow:blueprint-selected` event (Blueprint attach affordance) —
    // mirroring the decoupled 'flow:open-blueprint' convention. Chips
    // survive typing and thread refreshes; Esc never clears them; they are
    // folded into the message content on send (never a separate IPC field).
    this.#queueBar = document.createElement('div')
    this.#queueBar.className = 'fl-composer-queue'
    this.#queueBar.hidden = true

    this.#chipBar = document.createElement('div')
    this.#chipBar.className = 'fl-composer-chips'
    this.#chipBar.hidden = true
    document.addEventListener('flow:blueprint-selected', (event) => {
      const detail = (event as CustomEvent<Partial<BlueprintChipRef>>).detail
      if (
        !detail ||
        typeof detail.nodeId !== 'string' ||
        detail.nodeId.length === 0 ||
        typeof detail.label !== 'string'
      ) {
        return
      }
      this.#setChips(
        addChip(this.#chips, {
          nodeId: detail.nodeId,
          label: detail.label,
          kind: typeof detail.kind === 'string' ? detail.kind : 'node',
          ...(detail.proposal === true ? { proposal: true } : {}),
          // Forward the Story payload so a story step serializes as
          // [blueprint story: <plan>/<stepId> — <title>] instead of a plain,
          // plan-less, unresolvable [blueprint: story:<stepId> …] chip (#486).
          ...(detail.story !== undefined ? { story: detail.story } : {}),
          // Forward the browser-capture payload (embedded browser, #embedded-browser)
          // so an element/console/network capture serializes as
          // [browser: <captureKind> — <label>] instead of a plain [blueprint: …] line.
          ...(detail.browser !== undefined ? { browser: detail.browser } : {}),
        }),
      )
      this.#toastAttachedIfHidden(detail.label)
    })

    // ── Context selection chips (Terminal/File → Chat, cmd+L, #152) ──────────
    // A selection dispatched via `flow:add-to-chat` attaches as a BADGE (preview
    // only); the full text folds into the message content on send, like Cursor.
    document.addEventListener('flow:add-to-chat', (event) => {
      const detail = (event as CustomEvent<{ source?: unknown; text?: unknown; label?: unknown }>)
        .detail
      if (!detail || typeof detail.text !== 'string' || detail.text.trim().length === 0) return
      const source: ContextChipRef['source'] =
        detail.source === 'file' ? 'file' : detail.source === 'task' ? 'task' : detail.source === 'browser' ? 'browser' : 'terminal'
      const label =
        typeof detail.label === 'string' && detail.label.length > 0
          ? detail.label
          : source === 'file'
            ? 'File'
            : source === 'task'
              ? 'Task'
              : 'Terminal'
      this.#setContextChips(
        addContextChip(this.#contextChips, {
          id: contextChipId(source, detail.text),
          source,
          label,
          text: detail.text,
        }),
      )
      this.#toastAttachedIfHidden(label)
      this.#textarea.focus() // ready to type the question about the pasted context
    })

    // ── Programmatic image attach (embedded browser screenshot, #embedded-browser) ──
    // A producer with an already-materialized MessageAttachmentInput (the browser
    // capture-chip model auto-attaching a webview screenshot) drops it here, riding
    // the SAME attachment pipeline as picker/drag/paste — one add path, cap feedback
    // and all. Decoupled document event so no producer wires composer internals.
    document.addEventListener('flow:attach-image', (event) => {
      const detail = (event as CustomEvent<MessageAttachmentInput | undefined>).detail
      if (!detail || typeof detail.dataBase64 !== 'string' || detail.dataBase64.length === 0) return
      const { list, outcome } = addAttachmentWithOutcome(this.#attachments, detail)
      this.#setAttachments(list)
      if (outcome === 'cap-reached') this.#notifyAttachmentCap(1)
      else this.#toastAttachedIfHidden(detail.fileName)
    })

    // ── Composed send (a card's button, e.g. "Generate artifact") ─────────
    // `flow:send-prompt` { threadId, text } SENDS — unlike the prefill below —
    // through `#sendComposed`, the composer's own send path. Only for the
    // thread this composer is showing: a press from a card of another thread
    // never lands in this one.
    document.addEventListener('flow:send-prompt', (event) => {
      const text = composedPromptFor((event as CustomEvent<unknown>).detail, this.#thread?.id ?? null)
      if (text !== null) this.#sendComposed(text)
    })

    // ── Composer prefill (Resolve-with-AI, #66) ──────────────────────────
    // Sets the draft and focuses — NEVER sends. Fed by the decoupled
    // `flow:prefill-composer` event so the conflict-resolve glue (or any
    // future producer) can seed a message the user reviews before sending.
    document.addEventListener('flow:prefill-composer', (event) => {
      const detail = (event as CustomEvent<{ text?: unknown }>).detail
      if (!detail || typeof detail.text !== 'string' || detail.text.length === 0) return
      // #1416: DON'T DESTROY AN UNSENT DRAFT. Running a /skill from ⌘⇧P wrote
      // the command straight over whatever was being typed — not saved, not
      // ⌘Z-able, not recallable with ⬆, and nothing said so. That is the exact
      // harm #980 was filed and fixed for on the "Next step" button, whose fix
      // deliberately dispatches without touching the textarea "so an unsent
      // draft survives the click untouched".
      //
      // A draft in progress is kept and the command is appended on its own
      // line — the user's words survive and the thing they just asked for
      // still lands. And the write goes through the UNDOABLE path (#1214), so
      // ⌘Z reverses it either way.
      const existing = this.#textarea.value
      const draft = existing.trim()
      const next = draft === '' ? detail.text : `${existing.replace(/\s+$/, '')}\n${detail.text}`
      this.#replaceRange(0, existing.length, next)
      this.#autoGrow()
      // A programmatic value assignment does NOT fire `input`, so Send must be
      // re-synced explicitly — otherwise the seeded prompt (Resolve-with-AI)
      // leaves Send disabled and its primary action is a dead click (#433).
      this.#syncEnabled()
      void this.#updateSuggestions()
      this.#textarea.focus()
      // Caret to end so the user can keep typing.
      const end = this.#textarea.value.length
      this.#textarea.setSelectionRange(end, end)
    })

    // ── Input row ────────────────────────────────────────────────────────
    const inputWrap = document.createElement('div')
    inputWrap.className = 'fl-composer-input'

    this.#textarea = document.createElement('textarea')
    this.#textarea.rows = 3
    // The keys moved to the Send button's tooltip, where a keyboard equivalent
    // belongs and costs no width. What is left is what the box is FOR: the two
    // characters that open something, and nothing about how to submit.
    this.#textarea.placeholder = 'Plan, build, / for skills, @ for files'
    this.#textarea.addEventListener('input', () => {
      // A user edit while walking history makes this text a NEW draft (#776).
      this.#history = resetNavigation(this.#history)
      this.#autoGrow()
      this.#syncEnabled() // Send tracks whether there's anything to send (#430)
      this.#persistDraftSoon() // per-thread draft survives switch/relaunch (#1067)
      void this.#updateSuggestions()
    })
    this.#textarea.addEventListener('keydown', (event) => this.#onKeydown(event))
    // Paste an image from the clipboard (incl. a macOS ⌃⌘⇧4 screenshot) → attach it
    // instead of dropping raw bytes into the textarea (#456). Pasted text FILES
    // (Finder copy of an .md etc.) become context chips (#772).
    this.#textarea.addEventListener('paste', (event) => {
      const files = attachmentFilesFromDataTransfer(event.clipboardData)
      // One ingest path for picker/drop/paste (#1085): a paste whose files are
      // ALL rejected must still reach the refusal notice — silence here made
      // ⌘V of an unsupported file indistinguishable from a broken paste.
      if (this.#ingestAttachmentFiles(files)) {
        event.preventDefault()
      }
    })
    this.#textarea.addEventListener('blur', () => {
      this.#persistDraft() // flush the pending draft save on focus loss (#1067)
      // Delay so a click on a popup row lands before the popup closes.
      window.setTimeout(() => {
        this.#closeMention()
        this.#closeCommand()
      }, 150)
    })
    inputWrap.appendChild(this.#textarea)
    // Commands and @-files coloured while typing — a mirror behind the field
    // (composer-highlight.ts); the textarea stays the input.
    this.#highlight = new ComposerHighlight(this.#textarea, inputWrap)

    // Drag an image file onto the composer to attach it (#456). Only react when the
    // drag actually carries files, so text drags behave normally.
    const clearDrop = (): void => inputWrap.classList.remove('fl-composer-dropping')
    inputWrap.addEventListener('dragover', (event) => {
      if (!dragHasFiles(event.dataTransfer)) return
      event.preventDefault()
      inputWrap.classList.add('fl-composer-dropping')
    })
    inputWrap.addEventListener('dragleave', clearDrop)
    inputWrap.addEventListener('drop', (event) => {
      const files = attachmentFilesFromDataTransfer(event.dataTransfer)
      clearDrop()
      if (this.#ingestAttachmentFiles(files)) {
        event.preventDefault()
      }
    })

    this.#mentionPopup = document.createElement('div')
    this.#mentionPopup.className = 'fl-composer-mentions'
    this.#mentionPopup.hidden = true
    inputWrap.appendChild(this.#mentionPopup)

    this.#commandPopup = document.createElement('div')
    this.#commandPopup.className = 'fl-composer-mentions fl-composer-commands'
    this.#commandPopup.hidden = true
    inputWrap.appendChild(this.#commandPopup)

    // ── Controls row ─────────────────────────────────────────────────────
    const controls = document.createElement('div')
    controls.className = 'fl-composer-controls'

    this.#modelSelect = document.createElement('select')
    this.#modelSelect.className = 'fl-composer-select'
    this.#modelSelect.setAttribute('aria-label', 'Model')
    for (const option of modelOptionsFor(this.#modelProvider)) {
      const el = document.createElement('option')
      el.value = option.value
      el.textContent = option.label
      this.#modelSelect.appendChild(el)
    }
    this.#modelSelect.addEventListener('change', () => {
      this.#syncEffortEnabled()
      void this.#pushModelSelection()
    })

    this.#effortSelect = document.createElement('select')
    this.#effortSelect.className = 'fl-composer-select'
    this.#effortSelect.setAttribute('aria-label', 'Effort')
    for (const effort of EFFORT_OPTIONS) {
      const el = document.createElement('option')
      el.value = effort
      el.textContent = `effort: ${effort}`
      this.#effortSelect.appendChild(el)
    }
    this.#effortSelect.value = DEFAULT_EFFORT
    this.#effortSelect.addEventListener('change', () => {
      void this.#pushModelSelection()
    })

    /**
     * Autopilot — a TOGGLE, beside the box you type the instruction into.
     *
     * It used to be the words `autopilot on|off` at the far-left end of the
     * status bar: the one always-visible answer to "will this act without
     * asking me?", parked at the opposite corner of the window from the thing
     * it qualifies, and not clickable. Here it is next to the message, and
     * flipping it is the same gesture as reading it.
     *
     * IT IS NOT OPTIMISTIC. The click writes the key and the button waits for
     * the config watcher's broadcast to come back — the file is the truth
     * (flow/.flowconfig is hand-editable, and the CLI writes it too), so a
     * button that painted itself on click would be claiming a state it had
     * only requested. Disabled while the write is in flight, so a double-click
     * cannot race two writes.
     */
    this.#autopilotButton = document.createElement('button')
    this.#autopilotButton.type = 'button'
    this.#autopilotButton.className = 'fl-composer-autopilot'
    this.#autopilotButton.addEventListener('click', () => {
      void this.#toggleAutopilot()
    })
    this.#paintAutopilot()
    document.addEventListener('flow:autopilot', (event) => {
      const detail = (event as CustomEvent<{ rootId?: string; autopilot?: boolean }>).detail
      // Per-root, and this composer belongs to one thread in one project — so
      // it takes only its own, and never has to say whose flag it is showing.
      if (!detail || detail.rootId !== this.#thread?.projectRoot) return
      this.#autopilot = detail.autopilot === true
      this.#paintAutopilot()
    })

    // Live model indicator — sits next to the model picker and reads
    // "· using <model>" while the turn is working, from the SDK-resolved model
    // (accurate even for 'auto'). Hidden when idle (#129).
    this.#modelIndicator = document.createElement('span')
    this.#modelIndicator.className = 'fl-composer-model-indicator'
    this.#modelIndicator.hidden = true
    document.addEventListener('flow:active-model', (event) => {
      const detail = (event as CustomEvent<{ threadId?: string; model?: string }>).detail
      if (!detail || detail.threadId !== this.#thread?.id || typeof detail.model !== 'string') return
      this.#activeModel = detail.model
      this.#syncModelIndicator()
    })

    // ── Attach file(s) (#456, #772): file picker + hidden input, plus a
    //    macOS-only screenshot capture button. Paste + drag-drop are wired
    //    below. ──────────────────────────────────────────────────────────────
    const fileInput = document.createElement('input')
    fileInput.type = 'file'
    // Images ride the vision pipeline; text files (.md etc.) fold into context
    // chips (#772). The picker offers both.
    // `.har` last, and by extension: the OS reports a recording's type
    // inconsistently (application/json on one platform, empty on another), so
    // the name is what makes it pickable at all.
    fileInput.accept =
      'image/*,.md,.markdown,.txt,.log,.json,.jsonl,.yaml,.yml,.toml,.csv,.xml,.html,.css,.js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.go,.rs,.rb,.java,.sh,.sql,.har'
    fileInput.multiple = true
    fileInput.hidden = true
    fileInput.addEventListener('change', () => {
      const files = fileInput.files ? [...fileInput.files] : []
      fileInput.value = '' // allow re-selecting the same file
      this.#ingestAttachmentFiles(splitAttachmentFiles(files))
    })

    const attachButton = document.createElement('fl-button')
    attachButton.setAttribute('variant', 'ghost')
    attachButton.setAttribute('small', '')
    // #1176: the label names what the control ACCEPTS. It read "Attach image"
    // while its accept list carried 27 text extensions (.md/.ts/.py/.sql/…), so
    // a user wanting to hand the agent a spec, a log or a stack trace concluded
    // the app couldn't take documents and never found the #772 path — whose
    // only other routes, drag-drop and ⌘V, are undiscoverable by definition.
    attachButton.setAttribute('title', 'Attach an image or file')
    attachButton.setAttribute('aria-label', 'Attach an image or file')
    const attachIcon = document.createElement('fl-icon')
    attachIcon.setAttribute('name', 'file')
    attachIcon.setAttribute('size', '13')
    attachButton.appendChild(attachIcon)
    attachButton.addEventListener('click', () => fileInput.click())

    const captureButton = document.createElement('fl-button')
    captureButton.setAttribute('variant', 'ghost')
    captureButton.setAttribute('small', '')
    captureButton.setAttribute('title', 'Capture a screenshot region')
    captureButton.setAttribute('aria-label', 'Capture screenshot')
    const captureIcon = document.createElement('fl-icon')
    captureIcon.setAttribute('name', 'square-dot')
    captureIcon.setAttribute('size', '13')
    captureButton.appendChild(captureIcon)
    // Native region capture is macOS-only (main also gates it); HIDE elsewhere
    // rather than show a button that fails on click. Read from the authoritative
    // platform the preload bridge surfaces, not the deprecated navigator sniff.
    captureButton.hidden = !isCaptureAffordanceVisible(currentPlatform())
    captureButton.addEventListener('click', () => void this.#captureScreenshot())

    // Blueprint access from the chat itself (not only the status bar): opening
    // the board while you work a thread is a first-class action, so it rides the
    // composer control row alongside attach/capture. Decoupled via the same
    // document event the status-bar button and story card use.
    const blueprintButton = document.createElement('fl-button')
    blueprintButton.setAttribute('variant', 'ghost')
    blueprintButton.setAttribute('small', '')
    blueprintButton.setAttribute('title', 'Open Blueprint (⌘⇧B)')
    blueprintButton.setAttribute('aria-label', 'Open Blueprint')
    const blueprintIcon = document.createElement('fl-icon')
    blueprintIcon.setAttribute('name', 'map')
    blueprintIcon.setAttribute('size', '13')
    blueprintButton.appendChild(blueprintIcon)
    blueprintButton.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('flow:open-blueprint'))
    })

    // #1469: the actions sit last via margin-auto, not behind a `flex: 1`
    // spacer. A spacer that always claims the slack made the row wider than the
    // pane at the app's OWN default window size (1440px, sidebar + docked
    // terminal), and with no wrap and nothing shrinkable the overflow went to
    // the last items — Send, and Interrupt while a turn ran — laying them out
    // beyond the composer where they were invisible and unclickable.
    const actions = document.createElement('span')
    actions.className = 'fl-composer-actions'

    this.#interruptButton = document.createElement('fl-button')
    this.#interruptButton.setAttribute('small', '')
    this.#interruptButton.style.display = 'none'
    const stopIcon = document.createElement('fl-icon')
    stopIcon.setAttribute('name', 'close')
    stopIcon.setAttribute('size', '12')
    const stopLabel = document.createElement('span')
    stopLabel.textContent = 'Interrupt'
    this.#interruptButton.appendChild(stopIcon)
    this.#interruptButton.appendChild(stopLabel)
    this.#interruptButton.addEventListener('click', () => {
      void this.#interrupt()
    })

    this.#sendButton = document.createElement('fl-button')
    this.#sendButton.setAttribute('variant', 'primary')
    this.#sendButton.setAttribute('small', '')
    this.#sendSpinner = document.createElement('fl-icon')
    this.#sendSpinner.setAttribute('name', 'spinner')
    this.#sendSpinner.setAttribute('spin', '')
    this.#sendSpinner.setAttribute('size', '12')
    this.#sendLabel = document.createElement('span')
    this.#sendLabel.textContent = 'Send'
    // The keys the placeholder used to carry. A button's hover text is where a
    // keyboard equivalent belongs — it is attached to the thing it operates,
    // and it does not spend the width of an empty box saying it.
    this.#sendButton.setAttribute('title', 'Send (⏎) · ⇧⏎ for a newline')
    this.#sendButton.appendChild(this.#sendLabel)
    this.#sendButton.addEventListener('click', () => {
      void this.#send()
    })

    // The two selects stay in the DOM as the STATE; the menu is the surface.
    controls.appendChild(this.#modelSelect)
    controls.appendChild(this.#effortSelect)
    this.#modelEffort = createModelEffortMenu({
      modelSelect: this.#modelSelect,
      effortSelect: this.#effortSelect,
      // The context-window choice (#1929), shown only for Copilot with a
      // concrete model picked (Auto lets the runtime choose everything). The
      // choice persists per model in Flow's own settings; it is a preference,
      // not yet a per-turn lever — the headless CLI has no context flag.
      context: {
        isEnabled: (): boolean =>
          this.#modelProvider === 'copilot' && this.#modelSelect.value !== 'auto',
        get: (): RuntimeContextChoice => this.#modelContext[this.#modelSelect.value] ?? 'default',
        set: (choice: RuntimeContextChoice): void => {
          const model = this.#modelSelect.value
          this.#modelContext = { ...this.#modelContext, [model]: choice }
          void window.flow.settings
            .setModelContext?.({ provider: this.#modelProvider, model, context: choice })
            .catch(() => undefined)
        },
        label: (choice: RuntimeContextChoice): string => (choice === 'max' ? 'Max (1M)' : 'Default'),
      },
    })
    controls.appendChild(this.#modelEffort.element)
    controls.appendChild(this.#autopilotButton)
    controls.appendChild(attachButton)
    controls.appendChild(captureButton)
    controls.appendChild(blueprintButton)
    controls.appendChild(fileInput)
    controls.appendChild(this.#modelIndicator)
    actions.appendChild(this.#interruptButton)
    actions.appendChild(this.#sendButton)
    controls.appendChild(actions)

    // ONE box holds the input and its controls. They used to be two siblings
    // on the pane's own ground — an outlined text field, and under it a loose
    // row of bordered selects and buttons floating on the background — so the
    // thing you type into and the settings for what you type into it read as
    // unrelated furniture. Wrapping them makes the composer a single object,
    // which is also what lets every control inside it drop its own outline:
    // the shell is the edge, so nothing within needs one of its own.
    const shell = document.createElement('div')
    shell.className = 'fl-composer-shell'
    this.#shell = shell
    shell.appendChild(inputWrap)
    shell.appendChild(controls)

    container.appendChild(this.#suggestionBar)
    container.appendChild(this.#queueBar)
    container.appendChild(this.#chipBar)
    container.appendChild(shell)

    this.#syncEnabled()
    this.#syncEffortEnabled()

    // ── Thread scope (multi-project threads Phase 6) ─────────────────────
    // @-mentions iterate the scope's roots — the one scope source of truth
    // (allowed-pattern #14): initial value from getThreadScope, live updates
    // from threadScopeChanged. When the scope API is unavailable (older
    // preload, failed handler) #scope stays null and mention search sticks to
    // the thread's primary root, exactly as before (fail-soft).
    const projectApi = window.flow.project
    if (
      typeof projectApi.getThreadScope === 'function' &&
      typeof projectApi.onThreadScopeChanged === 'function'
    ) {
      const applyScope = (scope: ThreadScope): void => {
        this.#scope = scope
        // The scope's root set changed — cached listings may span dropped
        // roots, and open results may point into them.
        this.#dirCache.clear()
      }
      projectApi.onThreadScopeChanged(applyScope)
      void projectApi
        .getThreadScope()
        .then(applyScope)
        .catch(() => {
          // Scope layer unavailable — the primary-root fallback stays in charge.
        })
    }

    // ── Autocomplete cache invalidation (#1123/#1124) ────────────────────
    // The composer joins the other five surfaces (file tree, editor, review,
    // git, blueprint) on project.onFileChanged: a file created/deleted while
    // the user sits in one thread must reach the @-file popup, and a skill
    // provisioned/added mid-session must reach the /-skill popup. The caches
    // are refetched lazily, so invalidation is just a drop. (A fresh popup
    // session ALSO refetches — see #updateMention/#updateCommand — so truth
    // does not hinge on watcher delivery.)
    if (typeof projectApi.onFileChanged === 'function') {
      projectApi.onFileChanged((event) => {
        this.#dirCache.clear()
        if (touchesClaudeCommands(event.changes)) {
          this.#commands = null
          // A skill added or removed mid-session reaches the highlight too.
          void this.#listCommands()
        }
      })
    }
  }

  // ── Per-thread drafts (#1067) ─────────────────────────────────────────────
  // An unsent prompt belongs to the thread it was written for: saved on thread
  // switch / blur / debounced input, restored on thread open, cleared on send.
  // Persisted in localStorage (LRU-capped) so drafts survive a relaunch too —
  // the composer analog of the editor's #955 dirty buffers.

  /** Pending debounced draft save (input events); flushed on blur/switch. */
  #draftFlushTimer: number | null = null

  /** Debounced input-driven save so relaunch mid-typing loses ≤ a moment. */
  #persistDraftSoon(): void {
    if (this.#draftFlushTimer !== null) window.clearTimeout(this.#draftFlushTimer)
    this.#draftFlushTimer = window.setTimeout(() => {
      this.#draftFlushTimer = null
      this.#persistDraft()
    }, DRAFT_SAVE_DEBOUNCE_MS)
  }

  /** Save the CURRENT thread's textarea as its draft (no-op mid-history-walk —
   *  the on-screen text is a recalled entry, not the draft). */
  #persistDraft(): void {
    const threadId = this.#thread?.id
    if (!threadId || this.#history.index !== null) return
    this.#saveDraft(threadId, this.#textarea.value)
  }

  /** Write one thread's draft to the persisted store (empty text removes it). */
  #saveDraft(threadId: string, text: string): void {
    try {
      const store = parseDraftStore(localStorage.getItem(DRAFT_STORE_KEY))
      const next = withDraft(store, threadId, text)
      if (next !== store) localStorage.setItem(DRAFT_STORE_KEY, serializeDraftStore(next))
    } catch {
      // Best-effort persistence (quota/privacy modes) — never break the composer.
    }
  }

  /** The saved draft for a thread ('' when none). */
  #loadDraft(threadId: string): string {
    try {
      return draftFor(parseDraftStore(localStorage.getItem(DRAFT_STORE_KEY)), threadId)
    } catch {
      return ''
    }
  }

  /** Per-thread sent-message history (#776) — session-scoped, like a shell's. */
  #histories = new Map<string, ComposerHistory>()

  /** Threads whose history was seeded from PERSISTED messages (#776) — once. */
  #historySeeded = new Set<string>()

  get #history(): ComposerHistory {
    return this.#histories.get(this.#thread?.id ?? '') ?? emptyHistory()
  }

  set #history(value: ComposerHistory) {
    this.#histories.set(this.#thread?.id ?? '', value)
  }

  /** Seed a thread's recall history from its persisted user messages, once —
   *  so ArrowUp reaches messages from PREVIOUS sessions too (#776). Fail-soft
   *  and race-safe: skipped mid-navigation, and a fetch failure just leaves
   *  session-only history. */
  #seedHistory(threadId: string): void {
    if (this.#historySeeded.has(threadId)) return
    this.#historySeeded.add(threadId)
    void window.flow.messages
      .list({ threadId, limit: RECALL_SEED_MESSAGE_LIMIT })
      .then((messages) => {
        const texts = messages
          .filter((m) => m.role === 'user')
          .map((m) => recallableText(m.content))
        const current = this.#histories.get(threadId) ?? emptyHistory()
        if (current.index !== null) return // user is walking history — don't shift it
        this.#histories.set(threadId, seedEntries(current, texts))
      })
      .catch(() => undefined)
  }

  /**
   * Lock (or unlock) sending with a human-readable reason (#1931).
   *
   * Used for a promoted sub-agent child thread while its origin tool call is
   * still running — the sub-agent's conversation belongs to the origin session
   * until it finishes, so a reply sent now would fork it. The lock is a view
   * concern only: it disables the input and Send, it never touches the queue
   * or the thread.
   */
  setSendLock(reason: string | null): void {
    if (this.#sendLock === reason) return
    this.#sendLock = reason
    this.#syncEnabled()
  }

  /** Point the composer at a thread (null disables it). */
  setThread(thread: ThreadSummary | null): void {
    // Only a genuine thread SWITCH resets the transient suggestion. Same-thread
    // refreshes (status/title persists arriving as threads:updated) must not
    // wipe a suggestion the settle path just showed — that would race it away.
    const previous = this.#thread
    const switched = thread?.id !== previous?.id
    this.#thread = thread
    this.#dirCache.clear()
    this.#commands = null
    this.#closeMention()
    this.#closeCommand()
    // The highlight's command list follows the project on screen. Only a
    // switch (or a new project) refetches — same-thread refreshes arrive with
    // every threads:updated batch and must not each cost an IPC (forbidden #14).
    if (thread !== null && (switched || thread.projectRoot !== previous?.projectRoot)) {
      void this.#listCommands().then(() => this.#highlight.sync())
    }
    // A different thread's resolved model doesn't carry over — clear it until
    // the new thread's turn reports one (#129).
    if (switched) {
      if (previous) {
        // The unsent draft is PER-THREAD state (#1067): save the leaving
        // thread's typed text so returning restores it. Mid-history-walk the
        // on-screen text is a RECALLED entry, not the draft — the true draft
        // is what the history saved when the walk began (#776/#1013).
        const prevHistory = this.#histories.get(previous.id) ?? emptyHistory()
        const draftText = prevHistory.index !== null ? prevHistory.draft : this.#textarea.value
        this.#saveDraft(previous.id, draftText)
        // And reset the leaving thread's navigation cursor (#1013): a rebind is
        // "this is a new draft" exactly like a user edit — otherwise returning
        // silently RESUMES the old walk (newest message unreachable) and the
        // switch-discarded on-screen text lingers as a recallable zombie.
        this.#histories.set(previous.id, resetNavigation(prevHistory))
      }
      if (this.#draftFlushTimer !== null) {
        window.clearTimeout(this.#draftFlushTimer)
        this.#draftFlushTimer = null
      }
      if (thread) this.#seedHistory(thread.id)
      this.#setNextStep(null)
      this.#activeModel = null
      // A send lock is per-thread (#1931) — the arriving thread starts unlocked
      // and the sub-agent gate re-asserts it asynchronously if it applies.
      this.#sendLock = null
      // #1327 / #1328: SAY WHAT WAS DROPPED. Both drops below are deliberate
      // and correct — they must not misroute — but both were completely
      // silent, and every sibling drop in this composer is announced (the
      // 8-image cap #649, an unsupported paste #1085, an empty text file
      // #1086). The attachment drop is the worse of the two: #1067 restores
      // the TEXT that described the attachment, so the composer comes back
      // looking intact and the next ⏎ sends "compare the attached screenshot"
      // with nothing attached.
      const discarded = switchDiscardNotice(
        { attachments: this.#attachments.length, queued: this.#queue.length },
        previous?.title ?? '',
      )
      if (discarded !== null) {
        document.dispatchEvent(
          new CustomEvent('flow:notify', {
            detail: {
              kind: 'state-change',
              rootId: previous?.projectRoot ?? '',
              title: discarded.title,
              body: discarded.body,
              timestamp: new Date().toISOString(),
              level: discarded.level,
            },
          }),
        )
      }
      // Queued prompts belong to the thread they were composed for — drop them on a
      // switch so they can't misroute into a different thread (#472). Also clear any
      // pending Send-now interrupt so it can't drain into the new thread (#594).
      this.#setQueue([])
      this.#pendingSendNow = false
      // Attachments + chips composed for the thread being left don't follow the
      // user into the new thread — one Enter from misrouting (#688; mirrors the
      // queue drop above and task-board #591 / review-panel #281). The TEXT is
      // not dropped anymore: it was saved per-thread above and the new thread's
      // own saved draft (if any) is restored here (#1067).
      this.#textarea.value = thread ? this.#loadDraft(thread.id) : ''
      this.#setChips(clearChips())
      this.#setContextChips([])
      this.#setAttachments([])
      this.#autoGrow()
      this.#syncEnabled()
    }
    // The menu is a view over these; whoever writes them tells it so.
    this.#modelSelect.value = thread?.model ?? 'auto'
    if (!this.#modelOptions.some((option) => option.value === this.#modelSelect.value)) {
      this.#modelSelect.value = 'auto'
    }
    this.#effortSelect.value = isEffort(thread?.effort) ? thread.effort : DEFAULT_EFFORT
    this.setStatus(thread?.status ?? 'idle')
    this.#syncEffortEnabled()
  }

  /** Reflect the thread's live status (drives Send ↔ Interrupt). */
  setStatus(status: ThreadStatus): void {
    const prevStatus = this.#status
    this.#status = status
    this.#syncEnabled()
    this.#syncModelIndicator()
    // A "Send now" interrupt (#524) is armed for exactly ONE exit from `working`.
    // sendNowFlagTransition clears the flag on ANY working→non-working exit so it
    // can NEVER latch past this turn (a natural `done` or a needs-decision/blocked
    // pause pre-empting the interrupt would otherwise leave it set, letting a LATER
    // genuine Stop drain the queue against the user's stop button — #490, #594).
    const sendNow = sendNowFlagTransition(prevStatus, status, this.#pendingSendNow)
    if (sendNow.clear) this.#pendingSendNow = false
    // Auto-send the next queued prompt ONLY when the turn completed naturally
    // (`done`) (#472). Interrupt (`idle`), a failed turn (`failed`), and paused
    // states must NOT drain — that would launch a queued turn against the user's
    // stop button (#490). See shouldAutoDrainOnStatus for the full rationale.
    if (shouldAutoDrainOnStatus(prevStatus, status)) {
      this.#drainNext()
    } else if (sendNow.drainViaSendNow) {
      // "Send now" interrupted the running turn (#524); it has now exited `working`,
      // so fire the prompt the user jumped to the front. The flag was already
      // cleared above so a failed drain can't re-fire on a later transition.
      this.#drainNext()
    }
  }

  /**
   * Offer the models of the runtime that will actually run the turn.
   *
   * Called on mount and whenever the default runtime changes. A pinned model
   * that the new runtime does not have falls back to Auto rather than being
   * sent to a CLI that will refuse it.
   */
  setModelProvider(
    provider: string,
    extraModels: readonly string[] = [],
    untestedModels: readonly string[] = [],
    contextPreferences: Record<string, RuntimeContextChoice> = {},
  ): void {
    // Context prefs are stored BEFORE the signature short-circuit: they can
    // change (a Settings edit) while provider + model list stay identical, and
    // the menu's Context row reads this map live.
    this.#modelContext = contextPreferences
    const signature = `${provider}\u0000${extraModels.join(',')}\u0000${untestedModels.join(',')}`
    if (signature === this.#modelSignature) return
    this.#modelSignature = signature
    this.#modelProvider = provider
    const previous = this.#modelSelect.value
    // The base aliases plus the account's own ids, deduped and labelled — the
    // same list the new-thread page builds, from one code path (see
    // `model-options.ts`, allowed-pattern #14).
    const options: readonly RuntimeModelOption[] = buildModelOptions(provider, extraModels, untestedModels)
    this.#modelSelect.replaceChildren()
    for (const option of options) {
      const el = document.createElement('option')
      el.value = option.value
      el.textContent = option.label
      this.#modelSelect.appendChild(el)
    }
    this.#modelSelect.value = options.some((option) => option.value === previous) ? previous : 'auto'
    this.#modelOptions = options
    // A single choice is not a choice — hide the picker rather than showing a
    // dropdown with one entry.
    this.#modelSelect.hidden = options.length < 2
    this.#syncEffortEnabled()
  }

  /** Show "· using <model>" while the turn is working; hide it otherwise. */
  #syncModelIndicator(): void {
    const show = this.#status === 'working' && this.#activeModel !== null
    this.#modelIndicator.hidden = !show
    if (show) this.#modelIndicator.textContent = `· using ${modelLabel(this.#activeModel)}`
  }

  focus(): void {
    this.#textarea.focus()
  }

  /**
   * Put the thread's context (its project chips) INSIDE the composer box, on
   * the line above the text (user, 2026-10-06: "move that context selector to
   * inside of the chat") — the projects a message goes to belong with the
   * message, not floating above the box.
   */
  setContextSlot(element: HTMLElement): void {
    element.classList.add('fl-composer-context')
    this.#shell?.insertBefore(element, this.#shell.firstChild)
  }

  /** Let the project chips say a send carries the person's hand-picked projects. */
  setSkipContextGate(decide: (thread: ThreadSummary) => boolean): void {
    this.#skipContextGate = decide
  }

  /** Register the worktree step run just before a message is sent (Phase 5). */
  setOnPrepareWorktree(handler: (thread: ThreadSummary) => Promise<void>): void {
    this.#onPrepareWorktree = handler
  }

  /** Register the optimistic-echo callback (fired the instant a send starts). */
  setOnSend(
    handler: (content: string, attachments: readonly MessageAttachmentInput[]) => (() => void) | null,
  ): void {
    this.#onSend = handler
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  /** Paint the toggle from `#autopilot`. Label says the STATE; title says what
   *  pressing it will do, so the two never have to be read as one sentence. */
  #paintAutopilot(): void {
    const on = this.#autopilot
    this.#autopilotButton.textContent = on ? 'autopilot on' : 'autopilot off'
    this.#autopilotButton.classList.toggle('is-on', on)
    this.#autopilotButton.setAttribute('aria-pressed', String(on))
    this.#autopilotButton.title = on
      ? 'Autopilot is on — turn it off to be asked before each step'
      : 'Autopilot is off — turn it on to let the agent chain steps on its own'
  }

  /** Write the flag for this thread's project. The watcher rebroadcasts and
   *  `flow:autopilot` repaints the button; nothing is painted from here. */
  async #toggleAutopilot(): Promise<void> {
    const rootId = this.#thread?.projectRoot
    if (!rootId) return
    const next = !this.#autopilot
    this.#autopilotButton.disabled = true
    try {
      await window.flow.flow.setConfig({ rootId, updates: { autopilot: String(next) } })
    } catch (error) {
      console.warn('[composer] could not change autopilot', error)
    } finally {
      this.#autopilotButton.disabled = false
    }
  }

  async #send(): Promise<void> {
    const text = this.#textarea.value.trim()
    // Attached context/blueprint chips OR image attachments are sendable on their
    // own — the attachment is the message even with no typed text (#152, #456). NOTE:
    // a working turn is NOT refused here — it's queued below (#472).
    const hasContent = hasSendableContent(
      text,
      this.#chips.length,
      this.#contextChips.length,
      this.#attachments.length,
    )
    if (!this.#thread || !hasContent || this.#sending || this.#sendLock !== null) {
      return
    }
    const thread = this.#thread
    const chips = this.#chips
    const contextChips = this.#contextChips
    const attachments = this.#attachments
    // Record for ArrowUp recall (#776) — the TYPED text (not the serialized
    // chip content), covering both the live and queued paths below.
    this.#history = pushEntry(this.#history, text)
    // Chips fold into the CONTENT (the sendMessage IPC shape stays { threadId,
    // content }): blueprint one-line references, then context fenced blocks, then
    // the user's text.
    const content = serializeChips(chips, serializeContextChips(contextChips, text))
    // The agent is busy — one turn at a time. Instead of refusing, QUEUE the message
    // (#472): it auto-sends when the turn finishes; the user can remove it or send it
    // now. Clear the composer (the message is committed to the queue) and stop here.
    //
    // #1470: "busy" is not only `working`. A turn parked on a permission ask is
    // mid-flight too, and gating on `working` alone fired a LIVE send against it:
    // AgentManager.sendMessage flipped the thread to `working`, which destroyed the
    // needs-decision signal #949 built, left the pane claiming "Working…" while the
    // app was in fact waiting on the user, and delivered a message written to STOP
    // an action as a follow-up that runs after it. isComposerFreeStatus is the
    // composer's own predicate for this and already documents the rule.
    if (!isComposerFreeStatus(this.#status)) {
      this.#textarea.value = ''
      this.#saveDraft(thread.id, '') // the draft is committed to the queue (#1067)
      this.#autoGrow()
      this.#closeMention()
      this.#setChips(clearChips())
      this.#setContextChips([])
      this.#setAttachments([])
      this.#enqueue(content, attachments)
      return
    }
    // Clear the input immediately — the message is committed. Echo it into the
    // transcript before the round-trip so the user sees instant feedback instead of
    // a blank pane. Chips + attachments travel with the message (restored on failure).
    this.#textarea.value = ''
    this.#saveDraft(thread.id, '') // sent — the per-thread draft is done (#1067)
    this.#autoGrow()
    this.#closeMention()
    this.#setChips(clearChips())
    this.#setContextChips([])
    this.#setAttachments([])
    this.#dispatchContent(
      content,
      attachments,
      thread,
      () => {
        this.#textarea.value = text
        this.#setChips(chips)
        this.#setContextChips(contextChips)
        this.#setAttachments(attachments)
        this.#autoGrow()
      },
      // The user just pressed Enter/Send in the composer — refocusing it is correct.
      { refocus: true },
    )
  }

  /** Commit a message to the prompt queue (#472) — it auto-sends FIFO when the turn ends. */
  #enqueue(content: string, attachments: readonly MessageAttachmentInput[]): void {
    this.#setQueue(
      enqueuePrompt(this.#queue, {
        id: crypto.randomUUID(),
        content,
        attachments,
        preview: queuePreview(content, attachments),
      }),
    )
  }

  /**
   * Send a message a SURFACE composed for this thread (a card's button —
   * e.g. a discovery card's "Generate artifact" sending `/artifact @<doc>`).
   *
   * The composer's own send in every respect but the textarea: echoed through
   * the same dispatcher, queued exactly like a typed message while the turn is
   * busy (#472, #1470), recallable with ArrowUp. The draft being typed is never
   * touched, so nothing is restored on failure — the dispatcher's toast says
   * the send did not land.
   */
  #sendComposed(content: string): void {
    const thread = this.#thread
    if (!thread) return
    this.#history = pushEntry(this.#history, content)
    if (composedSendRoute(isComposerFreeStatus(this.#status), this.#sending) === 'queue') {
      this.#enqueue(content, [])
      return
    }
    this.#dispatchContent(content, [], thread, () => {}, { refocus: false })
  }

  /**
   * Dispatch a serialized message + its image attachments to a thread: optimistic
   * echo + sendMessage, with a rollback + draft-restore on failure. Used by #send
   * (live) and #drainNext (queued, #472) — the latter never touches the textarea, so
   * a queued send can't clobber a draft the user is typing while the previous turn ran.
   *
   * `refocus` makes the end-of-send refocus a property of the USER-INITIATED paths
   * (#send, #acceptNextStep), not of the dispatcher (#1045): a queued drain fires on
   * a background `working → done` stream event — the user pressed nothing — so
   * grabbing the keyboard there yanks the caret out of whatever field/editor/terminal
   * they moved on to, mid-word. Even when `refocus` is true, `#ownsFocus` re-checks
   * ownership so a slow round-trip can't steal focus back from a surface the user
   * has since moved to (same shape as the `restore()` guard below).
   */
  #dispatchContent(
    content: string,
    attachments: readonly MessageAttachmentInput[],
    thread: ThreadSummary,
    restore: () => void,
    opts: { refocus: boolean },
  ): void {
    this.#sending = true
    const rollback = this.#onSend?.(content, attachments) ?? null
    this.#syncEnabled()
    void (async () => {
      // The thread's worktree is settled BEFORE the message goes, never after:
      // a checkout created once the turn is running does not move that turn.
      // Its own failure is never this message's failure — a thread with no
      // worktree behaves exactly as every thread did before they existed.
      try {
        await this.#onPrepareWorktree?.(thread)
      } catch (error) {
        console.warn('flow: could not settle the thread worktree', error)
      }
      try {
        // Slash commands pass through verbatim — skills run in-session. Image
        // attachments ride alongside as vision blocks (#456).
        await window.flow.threads.sendMessage({
          threadId: thread.id,
          content,
          attachments: attachments.length > 0 ? [...attachments] : undefined,
          // The person hand-picked this thread's projects before its first
          // turn (the project chips), so the first send does not ask again.
          ...(this.#skipContextGate?.(thread) === true ? { skipContextGate: true } : {}),
        })
      } catch (error) {
        console.error('flow: failed to send message', error)
        // The send never landed — roll back the optimistic echo and tell the user,
        // so the message isn't misrepresented as sent (#279).
        rollback?.()
        document.dispatchEvent(
          new CustomEvent('flow:notify', {
            detail: {
              kind: 'state-change',
              rootId: '',
              ...sendFailedToast(error),
              timestamp: new Date().toISOString(),
            },
          }),
        )
        // Restore only if the composer still points at this thread (retry without
        // retyping) and nothing new has been typed since (don't clobber a fresh draft).
        if (this.#thread?.id === thread.id && this.#textarea.value.trim().length === 0) {
          restore()
        }
      } finally {
        this.#sending = false
        this.#syncEnabled()
        // Refocus only the user-initiated paths, and only while the keyboard is
        // still ours to reclaim — never on a background queue drain (#1045).
        if (opts.refocus && this.#thread?.id === thread.id && this.#ownsFocus()) {
          this.#textarea.focus()
        }
      }
    })()
  }

  /**
   * Whether the keyboard is still the composer's to reclaim (#1045): focus sits
   * inside the composer (textarea, Send/Queue, queue pills…) or was dropped on
   * body/nowhere. An element anywhere else — search box, editor, terminal — means
   * the user has put the caret there on purpose; never steal it.
   */
  #ownsFocus(): boolean {
    const active = document.activeElement
    return active === null || active === document.body || this.#container.contains(active)
  }

  // ── Blueprint reference chips (Board→Chat) ────────────────────────────────

  #setChips(chips: readonly BlueprintChipRef[]): void {
    if (chips === this.#chips) {
      return // addChip/dismissChip return the same array when nothing changed
    }
    this.#chips = chips
    this.#renderChips()
  }

  #setContextChips(chips: readonly ContextChipRef[]): void {
    if (chips === this.#contextChips) return
    this.#contextChips = chips
    this.#renderChips()
  }

  // ── Prompt queue (#472) ───────────────────────────────────────────────────

  #setQueue(queue: readonly QueuedPrompt[]): void {
    if (queue === this.#queue) return
    this.#queue = queue
    this.#renderQueue()
  }

  /** Send the next queued prompt when the composer is free (idle + not sending). */
  #drainNext(): void {
    if (
      !this.#thread ||
      this.#sending ||
      // #1470: a parked ask is not a free composer — draining into it would
      // launch the queued prompt as a live turn and un-park the decision.
      !isComposerFreeStatus(this.#status) ||
      this.#queue.length === 0
    ) {
      return
    }
    const { next, rest } = dequeue(this.#queue)
    if (!next) return
    this.#setQueue(rest)
    const thread = this.#thread
    // Dispatch the queued content + its attachments directly (chips were folded in at
    // queue time) — NOT via the textarea, so a draft the user is typing isn't
    // clobbered (#472); attachments ride along as vision blocks (#456).
    this.#dispatchContent(
      next.content,
      next.attachments,
      thread,
      () => {
        // On failure, restore BOTH text and attachments (mirroring the live #send
        // path) so a queued image isn't silently lost (#491) — but only into an empty
        // composer, so a fresh draft typed while the turn ran isn't clobbered.
        const { text, attachments } = queuedRestore(next, {
          hasText: this.#textarea.value.trim().length > 0,
          hasAttachments: this.#attachments.length > 0,
        })
        if (text !== null) this.#textarea.value = text
        if (attachments !== null) this.#setAttachments(attachments)
        if (text !== null || attachments !== null) this.#autoGrow()
      },
      // A drain is a BACKGROUND event — the trigger is `done` arriving on the
      // stream, not a keypress — so it must leave the keyboard alone (#1045).
      { refocus: false },
    )
  }

  /**
   * "Send now" — jump a queued prompt to the front and send it immediately (#524).
   *
   * If the composer is already free, drain right away (nothing to interrupt). If the
   * agent is working — the usual case, since a queue only exists while a turn runs —
   * a turn can't be interrupted to start another, so honour the label by INTERRUPTING
   * the running turn: mark `#pendingSendNow` and stop it; the jumped prompt then drains
   * on the exit from `working` (setStatus → shouldDrainAfterSendNow).
   */
  #sendNowQueued(id: string): void {
    this.#setQueue(moveToFront(this.#queue, id))
    if (this.#status === 'working') {
      this.#pendingSendNow = true
      void this.#interrupt()
      return
    }
    this.#drainNext()
  }

  #renderQueue(): void {
    this.#queueBar.textContent = ''
    this.#queueBar.hidden = this.#queue.length === 0
    for (const prompt of this.#queue) {
      const pill = document.createElement('div')
      pill.className = 'fl-composer-queue-item'
      // Tooltip: the full content when there is text; otherwise the preview names
      // the attachment(s) — never the empty string an image-only prompt used to
      // get (#1046).
      pill.title = prompt.content || prompt.preview
      const label = document.createElement('span')
      label.className = 'fl-composer-queue-preview'
      // Commands and @-files read the same here as in the input and the feed.
      if (prompt.preview) renderHighlightedText(label, prompt.preview)
      else label.textContent = '(empty)'
      const sendNow = document.createElement('button')
      sendNow.type = 'button'
      sendNow.className = 'fl-composer-queue-btn'
      sendNow.textContent = 'Send now'
      sendNow.title = 'Send this prompt next'
      sendNow.addEventListener('click', () => this.#sendNowQueued(prompt.id))
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'fl-composer-chip-dismiss'
      remove.setAttribute('aria-label', 'Remove from queue')
      const icon = document.createElement('fl-icon')
      icon.setAttribute('name', 'close')
      icon.setAttribute('size', '10')
      remove.appendChild(icon)
      remove.addEventListener('click', () => this.#setQueue(removeQueued(this.#queue, prompt.id)))
      pill.append(label, sendNow, remove)
      this.#queueBar.appendChild(pill)
    }
  }

  /**
   * When a reference is attached (Blueprint / cmd+L) but NO thread is active, the
   * composer is display:none, so the chip badge is invisible — a silent no-op. Toast
   * so the attach is acknowledged and the user knows it'll land in their next chat
   * (#366). With a thread open the visible chip badge is feedback enough.
   */
  #toastAttachedIfHidden(label: string): void {
    if (this.#thread) return
    const toast = attachedWhileHiddenToast(label)
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: { kind: 'state-change', rootId: '', ...toast, timestamp: new Date().toISOString() },
      }),
    )
  }

  #renderContextChips(): void {
    for (const chip of this.#contextChips) {
      const pill = document.createElement('span')
      pill.className = 'fl-composer-chip'
      pill.title = chip.text
      const kind = document.createElement('span')
      kind.className = 'fl-composer-chip-kind'
      kind.textContent = chip.label
      const label = document.createElement('span')
      label.className = 'fl-composer-chip-label'
      label.textContent = contextChipPreview(chip)
      const dismiss = document.createElement('button')
      dismiss.type = 'button'
      dismiss.className = 'fl-composer-chip-dismiss'
      dismiss.setAttribute('aria-label', `Remove ${chip.label} selection`)
      const icon = document.createElement('fl-icon')
      icon.setAttribute('name', 'close')
      icon.setAttribute('size', '10')
      dismiss.appendChild(icon)
      dismiss.addEventListener('click', () => {
        this.#setContextChips(dismissContextChip(this.#contextChips, chip.id))
      })
      pill.append(kind, label, dismiss)
      this.#chipBar.appendChild(pill)
    }
  }

  #setAttachments(attachments: readonly MessageAttachmentInput[]): void {
    if (attachments === this.#attachments) return
    this.#attachments = attachments
    this.#renderChips()
  }

  /**
   * The ONE ingest path for every attachment ingress — picker, drag-drop, and
   * ⌘V paste (#1085): images ride the vision pipeline, text files fold into
   * context chips, and rejects ALWAYS reach the refusal notice, so no ingress
   * can silently swallow a file again. Returns whether the batch carried
   * anything at all (the paste/drop callers preventDefault on true).
   */
  #ingestAttachmentFiles(split: ReturnType<typeof splitAttachmentFiles>): boolean {
    if (
      split.images.length === 0 &&
      split.texts.length === 0 &&
      split.hars.length === 0 &&
      split.rejected.length === 0
    ) {
      return false
    }
    if (split.images.length > 0) void this.#addImageFiles(split.images)
    if (split.texts.length > 0) void this.#addTextFiles(split.texts)
    if (split.hars.length > 0) void this.#addHarFiles(split.hars)
    this.#notifyRejectedAttachments(split.rejected)
    return true
  }

  /**
   * Attach a network recording by READING it, not by pasting it.
   *
   * A HAR is a few hundred structured records, not a long document: a real
   * capture runs 1–22 MB and the questions people open one to ask — what
   * failed, what was slow, who was talked to — fit in a few kilobytes. So the
   * chip carries the SUMMARY, and the recording itself stays on disk.
   *
   * `file.path` is Electron's, and it is the whole reason the summary can point
   * anywhere: a browser File has no path, but this is a desktop app and the
   * person picked a real file. Absent (a paste, or a stripped build) simply
   * means the summary says nothing about where the rest is.
   */
  async #addHarFiles(files: readonly File[]): Promise<void> {
    const skipped: { name: string; reason: AttachRejectReason }[] = []
    for (const file of files) {
      let text: string
      try {
        text = await file.text()
      } catch (error) {
        console.warn(`flow: could not read attached recording ${file.name}`, error)
        skipped.push({ name: file.name, reason: 'unreadable' })
        continue
      }
      const parsed = readHar(text)
      if (!parsed.ok) {
        // Named for what it is, not for what the parser said: the reader knows
        // they attached a .har, so "this is not JSON" is the useful half.
        console.warn(`flow: ${file.name} is not a HAR — ${parsed.reason}`)
        skipped.push({ name: file.name, reason: 'har-unreadable' })
        continue
      }
      const filePath = (file as File & { path?: string }).path ?? null
      const summary = harSummaryText({
        fileName: file.name,
        ...(filePath === null ? {} : { filePath }),
        byteSize: file.size,
        summary: parsed,
      })
      this.#setContextChips(
        addContextChip(this.#contextChips, {
          id: contextChipId('file', summary),
          source: 'file',
          label: file.name,
          text: summary,
        }),
      )
    }
    this.#notifyRejectedAttachments(skipped)
    this.#syncEnabled()
    this.#textarea.focus()
  }

  /** Fold text files (.md etc., #772) into context chips — content travels in
   *  the message as labeled fenced blocks, exactly like terminal selections.
   *  Files that yield nothing (whitespace-only, unreadable) are refused OUT
   *  LOUD (#1086) — a bare skip left the user believing the attach worked. */
  async #addTextFiles(files: readonly File[]): Promise<void> {
    const skipped: { name: string; reason: AttachRejectReason }[] = []
    for (const file of files) {
      let text: string
      try {
        text = await file.text()
      } catch (error) {
        console.warn(`flow: could not read attached file ${file.name}`, error)
        skipped.push({ name: file.name, reason: 'unreadable' })
        continue
      }
      if (text.trim().length === 0) {
        skipped.push({ name: file.name, reason: 'text-empty' })
        continue
      }
      this.#setContextChips(
        addContextChip(this.#contextChips, {
          id: contextChipId('file', text),
          source: 'file',
          label: file.name,
          text,
        }),
      )
    }
    this.#notifyRejectedAttachments(skipped)
    this.#syncEnabled()
    this.#textarea.focus()
  }

  /** Loud (never silent) feedback for refused attachment files (#772/#1086). */
  #notifyRejectedAttachments(
    rejected: readonly { name: string; reason: AttachRejectReason }[],
  ): void {
    for (const file of rejected) {
      document.dispatchEvent(
        new CustomEvent('flow:notify', {
          detail: {
            kind: 'state-change',
            rootId: '',
            title: "Couldn't attach file",
            body: rejectReasonMessage(file.name, file.reason),
            timestamp: new Date().toISOString(),
          },
        }),
      )
    }
  }

  async #addImageFiles(files: readonly File[]): Promise<void> {
    // Count cap-dropped images across the whole batch so a 10-image selection
    // raises ONE aggregated notice, not two identical toasts (#649).
    let capRejected = 0
    for (const file of files) {
      const validation = validateAttachment({ mediaType: file.type, byteSize: file.size })
      if (!validation.ok) {
        this.#toastAttachedIfHidden(validation.reason)
        document.dispatchEvent(
          new CustomEvent('flow:notify', {
            detail: {
              kind: 'state-change',
              rootId: '',
              title: 'Could not attach image',
              body: validation.reason,
              level: 'error',
              timestamp: new Date().toISOString(),
            },
          }),
        )
        continue
      }
      const dataBase64 = await fileToBase64(file)
      const input: MessageAttachmentInput = {
        id: attachmentId(file.type, file.size, dataBase64.slice(0, 32)),
        mediaType: file.type,
        fileName: file.name || 'image',
        byteSize: file.size,
        dataBase64,
      }
      const { list, outcome } = addAttachmentWithOutcome(this.#attachments, input)
      this.#setAttachments(list)
      if (outcome === 'cap-reached') capRejected += 1
    }
    if (capRejected > 0) this.#notifyAttachmentCap(capRejected)
    this.#textarea.focus()
  }

  /** The per-message image cap dropped `count` images — every sibling reject
   *  path (bad type / oversized / empty) toasts, so the cap must too (#649). */
  #notifyAttachmentCap(count: number): void {
    const body = `Only ${MAX_ATTACHMENTS_PER_MESSAGE} images per message — ${count} not attached`
    this.#toastAttachedIfHidden(body)
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: {
          kind: 'state-change',
          rootId: '',
          title: 'Image limit reached',
          body,
          level: 'error',
          timestamp: new Date().toISOString(),
        },
      }),
    )
  }

  /** macOS-only: interactive region capture via main, then attach the result. */
  async #captureScreenshot(): Promise<void> {
    try {
      const shot = await window.flow.attachments.captureScreen({})
      if (shot) {
        const { list, outcome } = addAttachmentWithOutcome(this.#attachments, shot)
        this.#setAttachments(list)
        // A captured screenshot silently vanishing on the cap is the same
        // no-feedback failure as the picker path (#649).
        if (outcome === 'cap-reached') this.#notifyAttachmentCap(1)
        this.#textarea.focus()
      }
    } catch (error) {
      console.warn('flow: screenshot capture failed', error)
    }
  }

  #renderAttachmentChips(): void {
    for (const attachment of this.#attachments) {
      const pill = document.createElement('span')
      pill.className = 'fl-composer-chip fl-composer-attachment'
      pill.title = attachment.fileName
      const thumb = document.createElement('img')
      thumb.className = 'fl-composer-attachment-thumb'
      thumb.src = attachmentDataUrl(attachment)
      thumb.alt = attachment.fileName
      const dismiss = document.createElement('button')
      dismiss.type = 'button'
      dismiss.className = 'fl-composer-chip-dismiss'
      dismiss.setAttribute('aria-label', `Remove ${attachment.fileName}`)
      const icon = document.createElement('fl-icon')
      icon.setAttribute('name', 'close')
      icon.setAttribute('size', '10')
      dismiss.appendChild(icon)
      dismiss.addEventListener('click', () => {
        this.#setAttachments(removeAttachment(this.#attachments, attachment.id))
      })
      pill.append(thumb, dismiss)
      this.#chipBar.appendChild(pill)
    }
  }

  #renderChips(): void {
    this.#chipBar.textContent = ''
    this.#chipBar.hidden =
      this.#chips.length === 0 && this.#contextChips.length === 0 && this.#attachments.length === 0
    // A chip is sendable content, so chip add/remove must refresh Send (#430).
    this.#syncEnabled()
    for (const chip of this.#chips) {
      const pill = document.createElement('span')
      pill.className = 'fl-composer-chip'
      pill.classList.toggle('proposal', chip.proposal === true)
      pill.title = chip.nodeId
      const kind = document.createElement('span')
      kind.className = 'fl-composer-chip-kind'
      kind.textContent = chip.proposal === true ? `${chip.kind} · proposal` : chip.kind
      const label = document.createElement('span')
      label.className = 'fl-composer-chip-label'
      label.textContent = chip.label
      const dismiss = document.createElement('button')
      dismiss.type = 'button'
      dismiss.className = 'fl-composer-chip-dismiss'
      dismiss.setAttribute('aria-label', `Remove ${chip.label}`)
      const icon = document.createElement('fl-icon')
      icon.setAttribute('name', 'close')
      icon.setAttribute('size', '10')
      dismiss.appendChild(icon)
      dismiss.addEventListener('click', () => {
        this.#setChips(dismissChip(this.#chips, chip.nodeId))
      })
      pill.append(kind, label, dismiss)
      this.#chipBar.appendChild(pill)
    }
    this.#renderContextChips()
    this.#renderAttachmentChips()
  }

  async #interrupt(): Promise<void> {
    if (!this.#thread) {
      return
    }
    try {
      await window.flow.threads.interrupt({ threadId: this.#thread.id })
    } catch (error) {
      console.error('flow: failed to interrupt thread', error)
    }
  }

  async #pushModelSelection(): Promise<void> {
    if (!this.#thread) {
      return
    }
    const model = this.#modelSelect.value
    // A pinned model carries the user's chosen effort. Auto does NOT: model
    // routing owns the tier, so carrying a manual effort would let the user
    // drive Auto through the back door — the exact thing #332 forbids. Omitting
    // it lets the backend route from the routing default instead.
    const selection =
      model === 'auto' ? { model } : { model, effort: asEffort(this.#effortSelect.value) }
    try {
      await window.flow.threads.setModel({ threadId: this.#thread.id, selection })
    } catch (error) {
      console.error('flow: failed to set model', error)
    }
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────

  #onKeydown(event: KeyboardEvent): void {
    if (!this.#mentionPopup.hidden) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const count = this.#mentionItems.length
        this.#mentionSelected = (this.#mentionSelected + delta + count) % count
        this.#renderMentionPopup()
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const item = this.#mentionItems[this.#mentionSelected]
        if (item) {
          void this.#acceptMention(item)
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        this.#closeMention()
        return
      }
    }
    if (!this.#commandPopup.hidden) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const count = this.#commandItems.length
        this.#commandSelected = (this.#commandSelected + delta + count) % count
        this.#renderCommandPopup()
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const item = this.#commandItems[this.#commandSelected]
        if (item) {
          this.#acceptCommand(item)
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        this.#closeCommand()
        return
      }
    }
    // Message-history recall (#776), shell-style: ArrowUp on the FIRST line
    // steps back through sent messages; ArrowDown on the LAST line steps
    // forward and finally restores the draft. Gated on caret line + collapsed
    // selection so multiline editing and text selection stay untouched; the
    // popup handlers above already consumed arrows while a menu is open.
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      this.#textarea.selectionStart === this.#textarea.selectionEnd
    ) {
      const caret = this.#textarea.selectionStart
      const value = this.#textarea.value
      const step =
        event.key === 'ArrowUp'
          ? caretOnFirstLine(value, caret)
            ? navigate(this.#history, 'back', value)
            : null
          : caretOnLastLine(value, caret)
            ? navigate(this.#history, 'forward', value)
            : null
      if (step !== null) {
        event.preventDefault()
        // #1369: route through the UNDOABLE write. #1214 named four places the
        // composer writes the textarea for the user with a raw
        // `this.#textarea.value = …` — an assignment that flushes Chromium's
        // native undo stack — and #1273 converted three of them. This was the
        // fourth, and it is the one that replaces the ENTIRE buffer: recalling
        // a history entry threw away everything typed since, with no ⌘Z.
        this.#replaceRange(0, this.#textarea.value.length, step.text)
        // THE WALK IS RECORDED AFTER THE WRITE, NEVER BEFORE. The undoable write
        // is a real `insertText`, so it fires the textarea's `input` event — and
        // that listener reads any input as a USER edit and resets navigation
        // (#776). Recorded first, the step was undone by its own write: every
        // ArrowUp started again from the newest entry, so recall could never
        // reach anything older than the last message, and ArrowDown never got
        // the draft back. That is how #1369 broke the walk it was protecting.
        this.#history = step.history
        this.#textarea.setSelectionRange(step.text.length, step.text.length)
        this.#autoGrow()
        this.#syncEnabled()
        return
      }
    }
    if (event.key === 'Enter') {
      // #139: Enter (and ⌘/Ctrl+Enter) sends; Shift/Alt+Enter breaks the line.
      const intent = enterKeyIntent({
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        isComposing: event.isComposing,
      })
      if (intent === 'none') return // IME confirming a character
      if (intent === 'newline') {
        // Shift+Enter breaks the line natively; Alt+Enter doesn't, so do it here.
        if (event.altKey && !event.shiftKey) {
          event.preventDefault()
          this.#insertNewline()
        }
        return
      }
      event.preventDefault()
      void this.#send()
    }
  }

  /**
   * Replace [start, end) with `text`, KEEPING the field's undo history (#1214).
   *
   * A raw `textarea.value = …` flushes Chromium's native undo stack, so after
   * any completion the composer inserted for you, ⌘Z was a dead key — you could
   * not take back the wrong file the @-popup just inserted, and every character
   * typed BEFORE it was unreachable too, with nothing on screen to signal it.
   *
   * This is the textarea analogue of what #1096 did for Monaco (pushEditOperations
   * instead of setValue): select the span and let the field perform the edit, so
   * it lands on the undo stack. execCommand is deprecated but remains the only
   * way to make a programmatic textarea edit undoable; it also fires a real
   * `input` event, so the #433 re-syncs happen naturally. Falls back to the
   * direct assignment if it is ever refused, so an insertion never silently
   * does nothing.
   */
  #replaceRange(start: number, end: number, text: string): void {
    const el = this.#textarea
    el.focus()
    el.setSelectionRange(start, end)
    const inserted = document.execCommand('insertText', false, text)
    if (!inserted) {
      el.value = el.value.slice(0, start) + text + el.value.slice(end)
      const caret = start + text.length
      el.setSelectionRange(caret, caret)
    }
  }

  /** Insert a newline at the caret (for modifier+Enter that doesn't do it). */
  #insertNewline(): void {
    const el = this.#textarea
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    // #1214: undoable — a raw assignment here killed ⌘Z for the whole draft.
    this.#replaceRange(start, end, '\n')
    this.#autoGrow()
  }

  // ── Autocomplete dispatch ──────────────────────────────────────────────────

  /** Route an input change to the `/`-command or `@`-file popup (or neither).
   *  Slash commands win when the whole prefix is a single `/token`. */
  async #updateSuggestions(): Promise<void> {
    const caret = this.#textarea.selectionStart
    const before = this.#textarea.value.slice(0, caret)
    const command = COMMAND_RE.exec(before)
    if (command && this.#thread) {
      this.#closeMention()
      await this.#updateCommand(command[1] ?? '', caret)
      return
    }
    this.#closeCommand()
    await this.#updateMention()
  }

  // ── /-slash commands (skills) ──────────────────────────────────────────────

  async #updateCommand(query: string, caret: number): Promise<void> {
    // A FRESH `/` session (no active range yet) refetches the command list so
    // the popup always opens on current truth — a skill provisioned or added
    // since the last `/` is offered, at the cost of one lazy IPC per session
    // (#1123). Keystrokes WITHIN a session keep the cached list.
    if (this.#commandRange === null) this.#commands = null
    // Capture the replacement range from the LIVE caret BEFORE the async
    // command-list fetch, mirroring #updateMention — otherwise a cold-cache
    // burst of keystrokes resolves out of order and a late resolver overwrites
    // #commandRange with a stale caret (#391). The command is the leading token.
    this.#commandRange = { start: 0, end: caret }
    const commands = await this.#listCommands()
    if (!this.#thread || !this.#commandRange) {
      this.#closeCommand()
      return
    }
    const needle = query.toLowerCase()
    const matches = commands
      .filter((command) => command.name.toLowerCase().includes(needle))
      .sort((a, b) => {
        const aPrefix = a.name.toLowerCase().startsWith(needle) ? 0 : 1
        const bPrefix = b.name.toLowerCase().startsWith(needle) ? 0 : 1
        if (aPrefix !== bPrefix) {
          return aPrefix - bPrefix
        }
        return a.name.localeCompare(b.name)
      })
      .slice(0, MAX_COMMAND_RESULTS)
    if (matches.length === 0) {
      this.#closeCommand()
      return
    }
    this.#commandItems = matches
    this.#commandSelected = 0
    // #commandRange was already set from the live caret before the await.
    this.#commandPopup.hidden = false
    this.#renderCommandPopup()
  }

  async #listCommands(): Promise<SlashCommand[]> {
    if (!this.#thread) {
      return []
    }
    // NEVER treat an empty listing as warm cache (#1123): `[]` is truthy, and a
    // fetch that raced IDE provisioning used to freeze the /-popup empty for
    // the whole thread. An empty result is returned but not trusted — the next
    // trigger refetches until commands actually exist.
    if (this.#commands && this.#commands.length > 0) {
      return this.#commands
    }
    try {
      const commands = await window.flow.project.listCommands({
        rootPath: this.#thread.projectRoot,
      })
      this.#commands = commands
      // The one list every command highlight reads (command-names.ts).
      publishCommandNames(commands)
      return commands
    } catch (error) {
      console.warn('flow: listCommands failed', error)
      return []
    }
  }

  #renderCommandPopup(): void {
    this.#commandPopup.textContent = ''
    this.#commandItems.forEach((command, index) => {
      const row = document.createElement('div')
      row.className = 'fl-composer-mention-row fl-composer-command-row'
      row.classList.toggle('selected', index === this.#commandSelected)
      const name = document.createElement('span')
      name.className = 'fl-composer-command-name'
      name.textContent = `/${command.name}`
      row.appendChild(name)
      if (command.description) {
        const desc = document.createElement('span')
        desc.className = 'fl-composer-command-desc'
        desc.textContent = command.description
        row.appendChild(desc)
      }
      row.addEventListener('mousedown', (event) => {
        event.preventDefault() // keep textarea focus
        this.#acceptCommand(command)
      })
      this.#commandPopup.appendChild(row)
    })
  }

  #acceptCommand(command: SlashCommand): void {
    if (!this.#commandRange) {
      return
    }
    // Derive the replacement span from the CURRENT value's leading /token, not
    // the stored range — the range's end can be stale from an out-of-order async
    // command-list resolution and would strand the last-typed char (#391).
    const { text, caret } = computeCommandInsertion(this.#textarea.value, command.name)
    // #1214: replace the whole value through the undoable path, so accepting a
    // /-skill completion doesn't flush the field's undo history.
    this.#replaceRange(0, this.#textarea.value.length, text)
    this.#textarea.setSelectionRange(caret, caret)
    this.#textarea.focus()
    this.#autoGrow()
    this.#syncEnabled() // programmatic value set → re-sync Send (#433)
    this.#closeCommand()
  }

  #closeCommand(): void {
    this.#commandPopup.hidden = true
    this.#commandItems = []
    this.#commandRange = null
  }

  // ── Next-step suggestion (workflow-aware) ──────────────────────────────────

  /**
   * Recompute the recommended next skill from the thread's history and render
   * the suggestion button. Called by the coordinator on thread select and
   * whenever a turn settles. Best-effort — a listing failure just hides it.
   */
  async refreshSuggestion(
    messages: ReadonlyArray<{ role: string; content: string }>,
  ): Promise<void> {
    const thread = this.#thread
    if (!thread) {
      this.#setNextStep(null)
      return
    }
    const commands = await this.#listCommands()
    if (this.#thread?.id !== thread.id) return
    this.#setNextStep(computeNextStepCommand(messages, commands))
  }

  #setNextStep(command: SlashCommand | null): void {
    this.#nextStep = command
    this.#renderSuggestion()
  }

  /**
   * Run the suggested skill immediately (sends `/name`). Dispatched DIRECTLY —
   * never through the textarea — so an unsent draft (text, chips, attachments)
   * survives the click untouched (#980). Same pattern as the queued path in
   * #drainNext, which exists precisely so a send can't clobber a live draft.
   */
  #acceptNextStep(): void {
    const command = this.#nextStep
    const thread = this.#thread
    if (!command || !thread || this.#sending || this.#status === 'working') {
      return
    }
    // Hide the suggestion right away; the send flips status to working and a
    // fresh suggestion is computed when this run settles.
    this.#setNextStep(null)
    // Record for ArrowUp recall (#776) — parity with a hand-typed /command.
    this.#history = pushEntry(this.#history, `/${command.name}`)
    this.#dispatchContent(
      `/${command.name}`,
      [],
      thread,
      () => {
        // The send never landed — bring the one-click suggestion back (the draft
        // was never touched, so there is nothing else to restore).
        this.#setNextStep(command)
      },
      // The user clicked the suggestion button inside the composer — refocusing is
      // user-initiated (and the clicked button hides itself, dropping focus).
      { refocus: true },
    )
  }

  /** Show the suggestion button when there is one and the thread is idle. */
  #renderSuggestion(): void {
    const command = this.#nextStep
    const show = command !== null && this.#thread !== null && this.#status !== 'working'
    this.#suggestionBar.hidden = !show
    if (!command) return
    this.#suggestionButton.textContent = ''
    const label = document.createElement('span')
    label.className = 'fl-composer-suggestion-label'
    label.textContent = 'Next step'
    const cmd = document.createElement('span')
    cmd.className = 'fl-composer-suggestion-cmd'
    cmd.textContent = `/${command.name}`
    this.#suggestionButton.append(label, cmd)
    if (command.description) {
      const desc = document.createElement('span')
      desc.className = 'fl-composer-suggestion-desc'
      desc.textContent = command.description
      this.#suggestionButton.appendChild(desc)
    }
  }

  // ── @-file mentions ──────────────────────────────────────────────────────

  async #updateMention(): Promise<void> {
    const caret = this.#textarea.selectionStart
    const before = this.#textarea.value.slice(0, caret)
    // #1417: accepts a QUOTED path too, so a name with spaces keeps
    // completing instead of ending the session the moment a space lands.
    const match = mentionTrigger(before)
    if (match === null || !this.#thread) {
      this.#closeMention()
      return
    }
    const query = match.query
    const queryStart = match.start // the '@'
    // A FRESH `@` session (no active range yet) drops the directory cache so
    // the popup opens on the filesystem as it is NOW — files created since the
    // last `@` are offered, deleted ones are not (#1124). Keystrokes and
    // directory descents WITHIN a session keep the per-directory cache.
    if (this.#mentionRange === null) this.#dirCache.clear()
    this.#mentionRange = { start: queryStart, end: caret }

    const slash = query.lastIndexOf('/')
    const dirPath = slash === -1 ? '' : query.slice(0, slash)
    const needle = (slash === -1 ? query : query.slice(slash + 1)).toLowerCase()

    // Cross-root search (Phase 6): iterate the thread scope's roots — one
    // request per root for a relative dirPath, or the single owning root for
    // an absolute one (descent inside an accepted cross-root directory). A
    // single-root scope produces exactly today's one request + ranking.
    const roots = mentionRoots(this.#scope, this.#thread.id, this.#thread.projectRoot)
    const results = await Promise.all(
      mentionListRequests(dirPath, roots).map(async (request) => ({
        root: request.root,
        entries: await this.#listDir(request.root.rootPath, request.dirPath),
      })),
    )
    if (!this.#mentionRange) {
      return // closed while fetching
    }
    const matches = mergeMentionMatches(results, needle, MAX_MENTION_RESULTS)

    if (matches.length === 0) {
      this.#closeMention()
      return
    }
    this.#mentionItems = matches
    this.#mentionSelected = 0
    this.#mentionPopup.hidden = false
    this.#renderMentionPopup()
  }

  async #listDir(rootPath: string, relPath: string): Promise<DirectoryEntry[]> {
    if (!this.#thread) {
      return []
    }
    const cacheKey = `${rootPath} ${relPath}`
    const cached = this.#dirCache.get(cacheKey)
    if (cached) {
      return cached
    }
    try {
      const entries = await window.flow.project.listDir({
        rootPath,
        ...(relPath ? { relPath } : {}),
      })
      this.#dirCache.set(cacheKey, entries)
      return entries
    } catch (error) {
      console.warn('flow: mention listDir failed', { rootPath, relPath, error })
      return []
    }
  }

  #renderMentionPopup(): void {
    this.#mentionPopup.textContent = ''
    this.#mentionItems.forEach((item, index) => {
      const { entry, root } = item
      const row = document.createElement('div')
      row.className = 'fl-composer-mention-row'
      row.classList.toggle('selected', index === this.#mentionSelected)
      const icon = document.createElement('fl-icon')
      icon.setAttribute('name', entry.type === 'directory' ? 'folder' : 'file')
      icon.setAttribute('size', '13')
      row.appendChild(icon)
      // Non-primary roots carry the project accent dot + name prefix (Phase 6);
      // primary-root rows render exactly as before (single-root byte-identical).
      if (!root.primary) {
        const dot = document.createElement('span')
        dot.className = 'fl-composer-mention-dot'
        dot.style.background = ensureAccentProperty(root.rootPath)
        row.appendChild(dot)
        const project = document.createElement('span')
        project.className = 'fl-composer-mention-project'
        project.textContent = `${root.name}/`
        row.appendChild(project)
      }
      const name = document.createElement('span')
      name.textContent = entry.type === 'directory' ? `${entry.name}/` : entry.name
      row.appendChild(name)
      row.addEventListener('mousedown', (event) => {
        event.preventDefault() // keep textarea focus
        void this.#acceptMention(item)
      })
      this.#mentionPopup.appendChild(row)
    })
  }

  async #acceptMention(item: ScopedMentionItem): Promise<void> {
    const range = this.#mentionRange
    if (!range || !this.#thread) {
      return
    }
    const { entry } = item
    // Primary-root entries insert today's root-relative path; cross-root
    // entries insert the absolute path (unambiguous for the agent, whose cwd
    // is the primary root, and re-parseable for directory descent).
    const relPath = mentionInsertionPath(item, this.#thread.projectRoot)
    const isDir = entry.type === 'directory'
    // #1417: quote what cannot be written bare. The popup offered paths with
    // spaces and then inserted a reference the composer could not read back —
    // `@design docs/` closed the popup, never reopened, and meant `@design`
    // followed by the plain words `docs/tokens.md` in the sent message.
    const insertion = `@${quoteMentionPath(`${relPath}${isDir ? '/' : ''}`)}${isDir ? '' : ' '}`
    // #1214: undoable, so ⌘Z takes back a wrong file picked from the popup.
    this.#replaceRange(range.start, range.end, insertion)
    const caret = range.start + insertion.length
    this.#textarea.setSelectionRange(caret, caret)
    this.#textarea.focus()
    this.#autoGrow()
    this.#syncEnabled() // programmatic value set → re-sync Send (#433)
    if (isDir) {
      await this.#updateMention() // descend one level, keep completing
    } else {
      this.#closeMention()
    }
  }

  #closeMention(): void {
    this.#mentionPopup.hidden = true
    this.#mentionItems = []
    this.#mentionRange = null
  }

  // ── State sync ───────────────────────────────────────────────────────────

  #syncEnabled(): void {
    const hasThread = this.#thread !== null
    // #1470: the label follows the same rule as the send path — a parked ask
    // queues, so it must not offer "Send".
    const working = !isComposerFreeStatus(this.#status)
    // Pending = the send is in flight but the session hasn't reported `working`
    // yet (SDK spin-up). Show a spinner on Send rather than a dead Interrupt.
    const pending = this.#sending && !working
    // #1931: a send lock (origin sub-agent still running) disables the input
    // and says why on it; the conversation banner carries the full sentence.
    const locked = this.#sendLock !== null
    this.#textarea.disabled = !hasThread || locked
    this.#textarea.title = this.#sendLock ?? ''
    // Send must reflect whether a send is actually possible — no dead click on
    // an empty/whitespace composer (#430). A chip-only OR image-only message is
    // still sendable, so count attachments too (matches #send) — otherwise Send
    // dims for an image-only message even though it would send fine (#541).
    const hasContent = hasSendableContent(
      this.#textarea.value,
      this.#chips.length,
      this.#contextChips.length,
      this.#attachments.length,
    )
    // While working the button becomes "Queue" (#472) when there's something to
    // queue — shown alongside Interrupt; otherwise Send is hidden as before.
    const canQueue = working && hasContent && hasThread && !this.#sending
    this.#sendButton.style.display = !working || canQueue ? '' : 'none'
    this.#interruptButton.style.display = working ? '' : 'none'
    this.#setSendMode(pending ? 'pending' : 'send')
    // The resting label is decided EVERY sync, not only on mode transitions:
    // #setSendMode early-returns when the mode is unchanged, so relying on it to
    // restore 'Send' left the button stuck on "Queue" after the turn ended (#722).
    // A working turn labels it "Queue" (#472); idle reads "Send". Not while
    // pending — that shows the "Sending…" spinner.
    if (!pending) this.#sendLabel.textContent = working ? 'Queue' : 'Send'
    if (!hasThread || this.#sending || !hasContent || locked) {
      this.#sendButton.setAttribute('disabled', '')
    } else {
      this.#sendButton.removeAttribute('disabled')
    }
    this.#modelSelect.disabled = !hasThread
    this.#syncEffortEnabled()
    // Status drives suggestion visibility (hidden while a turn is running).
    this.#renderSuggestion()
  }

  /** Swap the Send button between its resting state and a spinner without
   *  rebuilding the DOM on every sync. */
  #setSendMode(mode: 'send' | 'pending'): void {
    if (this.#sendMode === mode) {
      return
    }
    this.#sendMode = mode
    if (mode === 'pending') {
      this.#sendButton.insertBefore(this.#sendSpinner, this.#sendLabel)
      this.#sendLabel.textContent = 'Sending…'
    } else {
      this.#sendSpinner.remove()
      this.#sendLabel.textContent = 'Send'
    }
  }

  /** Also refreshes the model/effort menu, which reads these selects. */
  #syncEffortEnabled(): void {
    this.#modelEffort?.refresh()
    // Under Auto, plan-flow model routing owns the effort→model tier, so the
    // user must not override it (#332, superseding #147). Locked here; the user
    // pins a concrete model when they want to choose effort manually.
    const state = effortControlState(
      this.#modelSelect.value,
      this.#thread !== null,
      this.#modelProvider === 'claude',
    )
    this.#effortSelect.disabled = state.disabled
    this.#effortSelect.title = state.title
  }

  #autoGrow(): void {
    this.#textarea.style.height = 'auto'
    const height = Math.min(this.#textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)
    this.#textarea.style.height = `${height}px`
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isEffort(value: string | null | undefined): value is EffortLevel {
  return value === 'low' || value === 'medium' || value === 'high'
}

function asEffort(value: string): EffortLevel {
  return isEffort(value) ? value : DEFAULT_EFFORT
}

// ── Image-attachment helpers (#456) ─────────────────────────────────────────

/** Split a File batch into image / text / rejected buckets (#772). Rejected
 *  files carry the refusal reason the notifier will voice (#1086). */
function splitAttachmentFiles(files: readonly File[]): {
  images: File[]
  texts: File[]
  /** Network recordings — summarised on read, never pasted whole. */
  hars: File[]
  rejected: { name: string; reason: AttachRejectReason }[]
} {
  const images: File[] = []
  const texts: File[] = []
  const hars: File[] = []
  const rejected: { name: string; reason: AttachRejectReason }[] = []
  for (const file of files) {
    const cls: AttachClass = classifyAttachment(file.name, file.type, file.size)
    if (cls === 'image') images.push(file)
    else if (cls === 'text') texts.push(file)
    else if (cls === 'har') hars.push(file)
    else rejected.push({ name: file.name, reason: cls })
  }
  return { images, texts, hars, rejected }
}

/** splitAttachmentFiles over a DataTransfer's files (paste/drop ingress). */
function attachmentFilesFromDataTransfer(data: DataTransfer | null): ReturnType<typeof splitAttachmentFiles> {
  return splitAttachmentFiles(data ? [...data.files] : [])
}

/** Whether a drag carries files (vs. plain text/selection). */
function dragHasFiles(data: DataTransfer | null): boolean {
  return data != null && Array.from(data.types).includes('Files')
}

/** Whether a file-change batch touches `.claude/commands/` — the /-skill
 *  source of truth (#1123). Separator-agnostic (paths come from main). */
function touchesClaudeCommands(changes: readonly { path: string }[]): boolean {
  return changes.some((change) => change.path.replace(/\\/g, '/').includes('.claude/commands'))
}

/** Read a File's bytes as base64 (no data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      // data:<type>;base64,<payload> → strip the prefix.
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

// ── Styles (light DOM) ─────────────────────────────────────────────────────

let composerStylesInjected = false

function injectComposerStyles(): void {
  if (composerStylesInjected) {
    return
  }
  composerStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-composer {
      flex: none;
      display: flex;
      flex-direction: column;
      /* Centre the input and its bars on the SAME reading column the message
         feed uses (#1905): the surface footer stays edge-to-edge (it is the
         app's bottom bar), but what you type into now caps and lines up with
         the answers above it instead of stretching the full window width. */
      align-items: center;
      gap: var(--fl-space-xs);
      padding: var(--fl-space-sm) var(--fl-space-lg) var(--fl-space-md);
      /* NO rule above the input. The composer is now a box of its own with its
         own edge, so a line across the pane on top of it was drawing the same
         boundary twice — and the one that ran the full width was the one that
         read as a bar across the app. */
      background: var(--fl-color-surface);
    }
    /* Every row the composer stacks — the next-step suggestion, the queue, the
       chips and the input+controls shell — shares the reading column so they
       align with each other and with the feed. width:100% fills up to the cap;
       align-items:center keeps them centred once the window is wider than it. */
    .fl-composer > * {
      width: 100%;
      max-width: var(--fl-conv-column);
    }
    /* The composer as one object: the input and its controls share a ground,
       an edge and a focus state, so the box is what the eye reads and the
       controls inside it can be plain text. */
    .fl-composer-shell {
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-xs);
      padding: var(--fl-space-sm);
      background: var(--fl-color-bg);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-lg);
    }
    /* The focus ring belongs to the box now, not the textarea inside it —
       drawn as a shadow so gaining focus cannot resize the composer. */
    .fl-composer-shell:focus-within {
      border-color: var(--fl-color-focus-ring);
      box-shadow: 0 0 0 1px var(--fl-color-focus-ring);
    }
    .fl-composer-input { position: relative; }
    .fl-composer textarea {
      width: 100%;
      min-height: ${MIN_TEXTAREA_HEIGHT_PX}px;
      max-height: ${MAX_TEXTAREA_HEIGHT_PX}px;
      resize: none;
      /* No ground and no edge of its own — the shell owns both. */
      padding: var(--fl-space-xs) var(--fl-space-sm);
      background: transparent;
      border: none;
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-prose-size);
      line-height: var(--fl-line-height);
      outline: none;
    }
    .fl-composer textarea::placeholder { color: var(--fl-color-text-secondary); }
    .fl-composer textarea:disabled { opacity: 0.5; }
    /* The thread's projects, on their own line inside the box above the text. */
    .fl-composer-context { padding: 0 0 var(--fl-space-xs); }
    .fl-composer-controls {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      /* #1469: wrap rather than overflow. Whatever the width, the primary
         action stays inside the pane — on a second line if it must, never
         painted outside it under a neighbouring pane. */
      flex-wrap: wrap;
      row-gap: var(--fl-space-xs);
    }
    /* Laid out last, and never shrunk: the buttons are the point of the row. */
    .fl-composer-actions {
      display: inline-flex;
      align-items: center;
      gap: var(--fl-space-sm);
      flex: none;
      margin-left: auto;
    }
    /* Plain text with a chevron, not a boxed control. Inside the shell each
       select's own fill and outline was a small box drawn inside a bigger one,
       and two rows of edges is what made this corner of the app look busy. The
       affordance survives as hover. */
    .fl-composer-select {
      /* Give before the buttons do (#1469) — a truncated model name still
         works; a Send button outside the pane does not. */
      flex: 0 1 auto;
      min-width: 0;
      height: 22px;
      padding: 0 var(--fl-space-xs);
      background: transparent;
      border: var(--fl-border-width) solid transparent;
      border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      outline: none;
      cursor: pointer;
    }
    .fl-composer-select:hover:not(:disabled) {
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
    }
    .fl-composer-select:focus-visible { border-color: var(--fl-color-focus-ring); }
    /* The autopilot toggle wears the same clothes as the pickers beside it —
       it is one of the settings for the message, not a separate kind of thing.
       Only its ON state is coloured, because that is the state worth noticing. */
    .fl-composer-autopilot {
      flex: 0 1 auto;
      min-width: 0;
      height: 22px;
      padding: 0 var(--fl-space-xs);
      background: transparent;
      border: var(--fl-border-width) solid transparent;
      border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      white-space: nowrap;
      cursor: pointer;
    }
    .fl-composer-autopilot:hover:not(:disabled) {
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
    }
    .fl-composer-autopilot.is-on {
      color: var(--fl-color-accent);
      background: var(--fl-color-accent-muted);
    }
    .fl-composer-autopilot:focus-visible { border-color: var(--fl-color-focus-ring); }
    .fl-composer-autopilot:disabled { opacity: 0.5; cursor: default; }
    .fl-composer-select:disabled { opacity: 0.5; cursor: default; }
    .fl-composer-model-indicator {
      display: inline-flex;
      align-items: center;
      color: var(--fl-color-accent);
      font-size: var(--fl-text-caption-size);
      white-space: nowrap;
      /* Shrinkable too (#1469): "· using <model>" is informational, and it was
         one of the fixed-width items that pushed the buttons out. */
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .fl-composer-suggestion { display: flex; }
    .fl-composer-suggestion[hidden] { display: none; }
    .fl-composer-suggestion-btn {
      display: inline-flex;
      align-items: baseline;
      gap: var(--fl-space-xs);
      max-width: 100%;
      padding: 4px var(--fl-space-sm);
      background: var(--fl-color-accent-muted);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      cursor: pointer;
      text-align: left;
      overflow: hidden;
    }
    .fl-composer-suggestion-btn:hover { border-color: var(--fl-color-focus-ring); }
    .fl-composer-suggestion-label {
      flex: none;
      color: var(--fl-color-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-size: 10px;
    }
    .fl-composer-suggestion-cmd {
      flex: none;
      color: var(--fl-color-accent, var(--fl-color-text));
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-composer-suggestion-desc {
      flex: 1;
      min-width: 0;
      color: var(--fl-color-text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .fl-composer-chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--fl-space-xs);
    }
    .fl-composer-chips[hidden] { display: none; }
    /* Queued prompts (#472) — a stack of pills above the composer, auto-sent FIFO. */
    .fl-composer-queue { display: flex; flex-direction: column; gap: 3px; margin-bottom: var(--fl-space-xs); }
    .fl-composer-queue[hidden] { display: none; }
    .fl-composer-queue-item {
      display: flex; align-items: center; gap: var(--fl-space-xs);
      padding: 2px 4px 2px var(--fl-space-sm); border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface-raised); border: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-composer-queue-preview {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary);
    }
    .fl-composer-queue-btn {
      flex: none; border: none; background: none; cursor: pointer; padding: 0 4px;
      font-size: var(--fl-text-caption-size); color: var(--fl-color-accent);
    }
    .fl-composer-queue-btn:hover { text-decoration: underline; }
    .fl-composer-chip {
      display: inline-flex;
      align-items: center;
      gap: var(--fl-space-xs);
      max-width: 100%;
      padding: 2px var(--fl-space-xs) 2px var(--fl-space-sm);
      background: var(--fl-color-accent-muted);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text);
    }
    .fl-composer-chip.proposal { border-style: dashed; }
    .fl-composer-chip-kind {
      flex: none;
      font-family: var(--fl-font-mono);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 9px;
      color: var(--fl-color-text-secondary);
    }
    .fl-composer-chip-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fl-composer-chip-dismiss {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      padding: 0;
      background: transparent;
      border: none;
      border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text-secondary);
      cursor: pointer;
    }
    .fl-composer-chip-dismiss:hover { color: var(--fl-color-text); background: var(--fl-color-surface); }
    .fl-composer-chip-dismiss:focus-visible { outline: 1px solid var(--fl-color-focus-ring); }
    /* Image attachment chips (#456): a small thumbnail + dismiss. */
    .fl-composer-attachment { padding: 2px 4px 2px 2px; gap: 4px; }
    .fl-composer-attachment-thumb {
      width: 28px; height: 28px; object-fit: cover;
      border-radius: var(--fl-radius-sm); display: block;
    }
    /* Drop target highlight while dragging an image over the composer (#456). */
    .fl-composer-input.fl-composer-dropping::after {
      content: ''; position: absolute; inset: 0; pointer-events: none;
      border: 1px dashed var(--fl-color-accent); border-radius: var(--fl-radius-md);
      background: var(--fl-color-accent-muted);
    }
    .fl-composer-mentions {
      position: absolute;
      bottom: calc(100% + 4px);
      left: 0;
      min-width: 260px;
      max-width: 100%;
      max-height: 280px;
      overflow-y: auto;
      background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
      padding: var(--fl-space-xs) 0;
      z-index: 10;
    }
    .fl-composer-mention-row {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      height: 26px;
      padding: 0 var(--fl-space-md);
      font-size: var(--fl-text-ui-size);
      color: var(--fl-color-text);
      cursor: default;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .fl-composer-mention-row fl-icon { color: var(--fl-color-text-secondary); }
    .fl-composer-mention-row:hover { background: var(--fl-color-surface); }
    .fl-composer-mention-row.selected { background: var(--fl-color-accent-muted); }
    /* Cross-root mention results (Phase 6): project accent dot + name prefix. */
    .fl-composer-mention-dot {
      flex: none;
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .fl-composer-mention-project { color: var(--fl-color-text-secondary); }
    .fl-composer-commands { min-width: 340px; max-width: 560px; }
    .fl-composer-command-row {
      height: auto;
      min-height: 30px;
      padding-top: 5px;
      padding-bottom: 5px;
    }
    .fl-composer-command-name {
      flex: none;
      color: var(--fl-color-accent, var(--fl-color-text));
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-composer-command-desc {
      flex: 1;
      min-width: 0;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `
  document.head.appendChild(style)
}
