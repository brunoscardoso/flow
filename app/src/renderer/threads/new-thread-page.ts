/**
 * The new-thread PAGE — the centred composer that replaced the Create-thread
 * modal (user call 2026-09-04, against Cursor's new-chat screen).
 *
 * WHY A PAGE AND NOT A DIALOG. Starting a thread is the app's opening move, not
 * an interruption of something else. As a modal it dimmed the work behind it,
 * trapped focus, and stacked six labelled fields down a 500px box for a thing
 * most people finish by typing one sentence. As a page it is the same shape as
 * the thing it produces — a message box you type into, with its settings around
 * it — so the transition into the thread is continuous rather than a scene
 * change.
 *
 * IT KEEPS EVERY FIELD. Source, title (or reference), description, branch,
 * board tracking and the project selection are all still here and still
 * resolve to the same `ThreadDraft`. The rules stay in `create-modal.ts`, which
 * is where they already lived precisely so two surfaces could not disagree
 * about them (allowed-pattern #14) — this module owns the markup and nothing
 * else. That file's name is now the one thing about it that is wrong; renaming
 * it is a rename of every importer for no behavioural gain, so it keeps it.
 *
 * ONE PROMISE, ONE ANSWER. `open()` resolves exactly once — with a draft when
 * Create is pressed, or null when the page is dismissed — matching the modal's
 * contract so `#createThread` did not have to change at all.
 */
import '../components'
import {
  CREATE_SOURCES,
  EMPTY_THREAD_DRAFT,
  SOURCE_PLACEHOLDER,
  sourceLabel,
  submitState,
  taskCheckboxState,
  type CreateSource,
  type ThreadDraft,
} from './create-modal'
import { projectName } from './multi-project-picker'
import { buildModelOptions } from './model-options'
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentId,
  validateAttachment,
} from './image-attachment'
import { addAttachmentWithOutcome, removeAttachment } from './attachment-chips'
import { computeCommandInsertion } from './command-insertion'
import { createModelEffortMenu } from './model-effort-menu'
import { createNewThreadBranchChip } from './new-thread-branch-chip'
import { branchSeed, prepareRequestFor } from './new-thread-branch'
import { createHuntConfig, HUNT_CONFIG_STYLES } from '../loops/hunt-config-view'
import { emptyHuntConfig } from '../loops/hunt-config'
import type {
  LoopsSnapshot,
  MessageAttachmentInput,
  SlashCommand,
  WorktreeBranchChoices,
  WorktreeStart,
  RegisteredProject,
} from '../../shared/ipc-contract'

/**
 * The effort levels, spelled here rather than imported from the composer.
 *
 * The composer's copy is a module-private const in a 2,300-line file whose
 * export surface is a class; exporting it to share three strings would widen
 * that surface for no invariant. If a fourth level ever appears, the runtime
 * contract is what both read — this is a list of labels, not a rule.
 */
const EFFORTS = ['low', 'medium', 'high'] as const

/**
 * The description IS the first message, and a slash command is only valid as its
 * first token — the same rule the chat composer follows (`COMMAND_RE` there). So
 * the / menu opens on typing only when the whole description so far is `/` or
 * `/word`, which is exactly what `computeCommandInsertion` knows how to replace.
 */
const COMMAND_RE = /^\/([\w-]*)$/

/** Cap the typed-filter list the way the composer does, so a cold list scans. */
const MAX_COMMAND_RESULTS = 12

/** What the page needs to show a fresh draft. */
export interface NewThreadPageRequest {
  roots: readonly RegisteredProject[]
  primary: string | null
  /**
   * The project's slash commands, for the / menu. Resolved by the caller (it
   * owns the project bridge) and passed in already-fetched, so the page stays
   * DOM-and-state only and can be opened in a test without an IPC bridge.
   */
  commands?: readonly SlashCommand[]
  /**
   * The project's loops, for the "keep looking" switch. Optional and separately
   * settable for the same reason as `commands`: reading them is a round trip,
   * and the page must draw before it lands.
   */
  loops?: LoopsSnapshot | null
  /**
   * Text the description starts with — a prompt another surface composed for
   * the new thread (a ⌘P slash command picked with no thread open). It is the
   * first message, so it lands where the first message is written, ready to
   * finish or send, rather than in a conversation composer that does not exist
   * yet.
   */
  prompt?: string
}

export interface NewThreadPage {
  element: HTMLElement
  /**
   * Show the page for a fresh draft and resolve when the person decides.
   *
   * Re-opening while one is already pending settles the old promise with null
   * first: two live asks for one answer is how a caller ends up waiting forever
   * on the one nobody is looking at.
   */
  open(input: NewThreadPageRequest): Promise<ThreadDraft | null>
  /**
   * Hand over the project's slash commands once they have been fetched.
   *
   * Separate from `open` on purpose: fetching them is a round trip, and awaiting
   * it before opening left the page ON SCREEN but UNRENDERED for the length of
   * that trip — title field still showing, chips blank. The page draws
   * immediately with no commands and the / menu fills in when the list lands.
   */
  setCommands(commands: readonly SlashCommand[]): void
  /**
   * Hand over the project's loops once they have been read.
   *
   * `null` means "not read yet" and is a real answer — the switch says so
   * rather than claiming the project has no loop that looks for work.
   */
  setLoops(loops: LoopsSnapshot | null): void
  /**
   * Hand over the branches this project could start from, once they have been
   * read.
   *
   * Same terms as `setCommands` and `setLoops`, and for the same reason: the
   * read is a round trip, and awaiting it before opening would leave the page
   * on screen and unrendered for the whole of it. `null` means "not read yet",
   * which the chip renders as a menu without its third rung rather than as a
   * project with no branches.
   */
  setBranches(branches: WorktreeBranchChoices | null): void
  /**
   * Hand over the two worktree settings that shape the branch chip's default —
   * where a new conversation begins and whether it may have a checkout of its
   * own — once the project's settings have been read.
   *
   * Same open-then-fetch terms as `setBranches`; until it lands the chip uses
   * the built-in start and asks for nothing it would need a setting to allow.
   */
  setWorktreeDefaults(defaults: { start: WorktreeStart; worktreesAllowed: boolean }): void
  /**
   * Hand over the active runtime provider and the models it offers, once the
   * caller has read them.
   *
   * Same open-then-fetch terms as `setCommands`/`setLoops`/`setBranches`: the
   * page opens on a placeholder Claude-alias list and this overwrites it, so the
   * Model dropdown offers the ids configured for Copilot/Codex (Settings →
   * Models) rather than Claude's aliases — the fix for #1918. `extraModels` is
   * the account's own ids (configured + discovered), deduped and labelled by the
   * shared builder.
   */
  setRuntimeModels(
    provider: string,
    extraModels: readonly string[],
    untestedModels?: readonly string[],
  ): void
  /** Dismiss without a draft (the tab was closed, the project changed, …). */
  cancel(): void
}

export function createNewThreadPage(onClose: () => void): NewThreadPage {
  injectStyles()

  const element = document.createElement('div')
  element.className = 'fl-newthread'

  const card = document.createElement('div')
  card.className = 'fl-newthread-card'
  element.appendChild(card)

  // ── State ───────────────────────────────────────────────────────────────
  let draft: ThreadDraft = { ...EMPTY_THREAD_DRAFT, roots: [], attachments: [] }
  let roots: readonly RegisteredProject[] = []
  let commands: readonly SlashCommand[] = []
  let settle: ((value: ThreadDraft | null) => void) | null = null

  // ── / menu state ──────────────────────────────────────────────────────────
  // The rows currently drawn (already filtered), which one is highlighted, and
  // how the list was opened. TYPED mode replaces the `/query` being typed; the
  // footer BUTTON mode appends, because there is no token under the caret to
  // replace — the two openings insert differently and must remember which they are.
  let commandRows: SlashCommand[] = []
  let commandSelected = 0
  let commandMode: 'typed' | 'button' = 'button'

  const finish = (value: ThreadDraft | null): void => {
    const resolve = settle
    settle = null
    resolve?.(value)
    if (resolve) onClose()
  }

  // ── Settings row, above the box (the reference's project · branch · host) ──
  const settings = document.createElement('div')
  settings.className = 'fl-newthread-settings'
  card.appendChild(settings)

  const sourcePicker = document.createElement('select')
  sourcePicker.className = 'fl-newthread-select'
  sourcePicker.setAttribute('aria-label', 'Where this thread comes from')
  for (const entry of CREATE_SOURCES) {
    const option = document.createElement('option')
    option.value = entry.key
    option.textContent = entry.label
    sourcePicker.appendChild(option)
  }
  sourcePicker.addEventListener('change', () => {
    draft.source = sourcePicker.value as CreateSource
    render()
    primaryField.focus()
  })
  settings.appendChild(sourcePicker)

  // Model and effort — the runtime settings for the turn this page is about to
  // start. They live beside the source because they are the same kind of thing:
  // decisions about the thread, made before it exists. Blank = the thread's own
  // default, so leaving them alone changes nothing.
  const modelPicker = document.createElement('select')
  modelPicker.className = 'fl-newthread-select'
  modelPicker.setAttribute('aria-label', 'Model')

  // Rebuild the picker for a runtime, through the ONE shared helper the composer
  // also uses (allowed-pattern #14). It starts on the Claude aliases as a
  // pre-fetch placeholder and is overwritten by `setRuntimeModels` once the
  // caller has read the active runtime — so a Copilot user sees the ids they
  // configured in Settings, not Claude's aliases (#1918). Preserve the current
  // pick if it survives; otherwise fall back to Auto. A single choice is not a
  // choice — hide the picker rather than show a one-entry dropdown, matching the
  // composer.
  const rebuildModelPicker = (
    provider: string,
    extraModels: readonly string[],
    untestedModels: readonly string[] = [],
  ): void => {
    const previous = modelPicker.value
    const options = buildModelOptions(provider, extraModels, untestedModels)
    modelPicker.replaceChildren()
    for (const option of options) {
      const entry = document.createElement('option')
      entry.value = option.value
      entry.textContent = option.label
      modelPicker.appendChild(entry)
    }
    modelPicker.value = options.some((option) => option.value === previous) ? previous : 'auto'
    modelPicker.hidden = options.length < 2
    draft.model = modelPicker.value
  }
  // THE PLACEHOLDER DOES NOT GUESS A RUNTIME. It used to build Claude's aliases
  // before anything had been read, so a Copilot user opening this page saw
  // Fable/Opus/Sonnet — a list belonging to a runtime they were not using, and
  // beside a composer already showing Copilot's own ids (user, 2026-09-16).
  //
  // `modelOptionsFor` answers "the runtime chooses" (Auto alone) for anything
  // that is not Claude, so an empty provider is the honest pre-read state: one
  // entry, the picker hidden, and nothing claimed. `setRuntimeModels` fills it
  // — at app mount, on every runtime change, and on every open — so by the time
  // a person looks, the real list is already in.
  rebuildModelPicker('', [])

  modelPicker.addEventListener('change', () => {
    draft.model = modelPicker.value
  })
  // Kept as the state, drawn by the menu in the footer (see below).

  const effortPicker = document.createElement('select')
  effortPicker.className = 'fl-newthread-select'
  effortPicker.setAttribute('aria-label', 'Effort')
  for (const level of EFFORTS) {
    const entry = document.createElement('option')
    entry.value = level
    entry.textContent = `effort: ${level}`
    effortPicker.appendChild(entry)
  }
  effortPicker.value = 'medium'
  effortPicker.addEventListener('change', () => {
    draft.effort = effortPicker.value
  })


  // The board checkbox, as a pressable chip rather than a labelled box: it is
  // one of three settings on a row, not a form field.
  const boardChip = document.createElement('button')
  boardChip.type = 'button'
  boardChip.className = 'fl-newthread-chip'
  boardChip.addEventListener('click', () => {
    if (taskCheckboxState({ source: draft.source, asTask: draft.asTask }).disabled) return
    draft.asTask = !draft.asTask
    render()
  })
  settings.appendChild(boardChip)

  // ── Keep looking ────────────────────────────────────────────────────────
  // The same control the board's New task carries — a hunt is created with the
  // work that prompted it, carrying the rule that ends it, instead of being
  // switched on somewhere else and left running.
  //
  // IT LIVES BESIDE "On the task board", AND ONLY WHEN THAT IS ON. Both are
  // decisions about the same thing — whether this thread becomes tracked work,
  // and whether that work keeps going — so they belong in one place rather than
  // at opposite ends of the card. A hunt against a thread that is not on the
  // board would file findings nobody is looking at a list for.
  const hunt = createHuntConfig(() => paintSubmit(), 'chip')
  settings.appendChild(hunt.toggleEl)
  const huntPanel = document.createElement('div')
  huntPanel.className = 'fl-newthread-hunt'
  huntPanel.appendChild(hunt.panelEl)
  card.insertBefore(huntPanel, settings.nextSibling)

  /**
   * Autopilot, the same toggle the composer carries — this page is where the
   * first turn is set up, and "will this act without asking me?" is a question
   * about that turn as much as any later one.
   *
   * It belongs to the PROJECT, not the draft, so it is not part of the answer
   * this page resolves: it writes through the same one code path the composer
   * uses and repaints from the broadcast that comes back.
   */
  const autopilotChip = document.createElement('button')
  autopilotChip.type = 'button'
  autopilotChip.className = 'fl-newthread-chip'
  let autopilot = false
  const paintAutopilot = (): void => {
    autopilotChip.textContent = autopilot ? 'autopilot on' : 'autopilot off'
    autopilotChip.classList.toggle('is-on', autopilot)
    autopilotChip.setAttribute('aria-pressed', String(autopilot))
    autopilotChip.title = autopilot
      ? 'Autopilot is on — turn it off to be asked before each step'
      : 'Autopilot is off — turn it on to let the agent chain steps on its own'
  }
  autopilotChip.addEventListener('click', () => {
    const rootId = draft.roots[0]
    if (!rootId) return
    autopilotChip.disabled = true
    void window.flow.flow
      .setConfig({ rootId, updates: { autopilot: String(!autopilot) } })
      .catch((error: unknown) => console.warn('[new-thread] could not change autopilot', error))
      .finally(() => {
        autopilotChip.disabled = false
      })
  })
  document.addEventListener('flow:autopilot', (event) => {
    const detail = (event as CustomEvent<{ rootId?: string; autopilot?: boolean }>).detail
    // Only this page's primary project — the same per-root rule the composer
    // follows, so the chip can never answer for a project nobody is looking at.
    if (!detail || detail.rootId !== draft.roots[0]) return
    autopilot = detail.autopilot === true
    paintAutopilot()
  })
  paintAutopilot()

  // ── The box ─────────────────────────────────────────────────────────────
  const shell = document.createElement('div')
  shell.className = 'fl-newthread-shell'
  card.appendChild(shell)

  /**
   * NO TITLE FIELD from scratch.
   *
   * Asking for one made the first thing a person did the one thing they had the
   * least to say about — you know what you want to ask before you know what to
   * call it — and the app already names an untitled thread from its opening
   * message. So the description IS the ask, and the title comes out of it.
   *
   * The field survives for the three IMPORT sources, where it holds the issue
   * reference: that one really is a value only a person can supply, and there is
   * nothing to derive it from.
   */
  const primaryField = document.createElement('input')
  primaryField.type = 'text'
  primaryField.className = 'fl-newthread-title'
  primaryField.addEventListener('input', () => {
    draft.reference = primaryField.value
    paintSubmit()
  })
  shell.appendChild(primaryField)

  const description = document.createElement('textarea')
  description.className = 'fl-newthread-body'
  description.rows = 3
  // SHORT. It read "What do you want to do? — / for commands, sent as the first
  // message": a question, an instruction and a footnote, in a box whose whole
  // job is to look like somewhere to start typing. Two verbs and the one key
  // that does something is the whole useful part. No "@ for context" here —
  // this box has no mention autocomplete, and offering one would be a promise
  // the page cannot keep.
  description.placeholder = 'Plan, build, / for commands'
  description.addEventListener('input', () => {
    draft.description = description.value
    paintSubmit()
    // Typing `/` at the start opens the same list the footer button does — the
    // placeholder promises "/ for commands", so the key has to do it, not just
    // the click (the whole reason the list looked click-only before).
    syncCommandMenu()
  })
  // Keyboard drive the / list while it is open: arrows move, Enter inserts,
  // Escape closes it WITHOUT dismissing the page (its keydown handler treats a
  // bare Escape as "cancel the thread").
  description.addEventListener('keydown', (event) => {
    if (commandMenu.hidden || commandRows.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveCommandSelection(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveCommandSelection(-1)
    } else if (event.key === 'Enter') {
      // In the textarea a bare Enter is a newline; while the menu is open it
      // commits the highlighted command instead.
      event.preventDefault()
      const picked = commandRows[commandSelected]
      if (picked) pickCommand(picked)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeCommandMenu()
    }
  })
  shell.appendChild(description)

  // Attached images, above the footer so they read as part of the message
  // rather than as another control.
  const attachRow = document.createElement('div')
  attachRow.className = 'fl-newthread-attachments'
  attachRow.hidden = true
  shell.appendChild(attachRow)

  const footer = document.createElement('div')
  footer.className = 'fl-newthread-footer'
  shell.appendChild(footer)

  // A hidden <input type=file> is the only way to open a native picker from a
  // button; it never renders.
  const filePicker = document.createElement('input')
  filePicker.type = 'file'
  filePicker.accept = 'image/png,image/jpeg,image/gif,image/webp'
  filePicker.multiple = true
  filePicker.style.display = 'none'
  filePicker.addEventListener('change', () => {
    void takeFiles(Array.from(filePicker.files ?? []))
    filePicker.value = ''
  })
  footer.appendChild(filePicker)

  // The composer's own footer glyphs, so the two message boxes in this app do
  // not use different marks for the same two verbs.
  const attachBtn = footerButton('file', 'Attach an image', () => filePicker.click())
  footer.appendChild(attachBtn)

  // The / menu. The composer offers these while you type; here there is no
  // typing yet, so the same commands get a control of their own — otherwise
  // the one place a person opens a thread to RUN a skill is the one place the
  // skills are invisible.
  const commandBtn = footerButton('slash', 'Insert a command', () => toggleCommands())
  footer.appendChild(commandBtn)

  // EVERYTHING ABOUT THE MESSAGE, INSIDE THE MESSAGE BOX. Model, effort and
  // autopilot are settings for the turn this box is about to start, so they sit
  // on its own footer rather than on a row above it — the same arrangement the
  // composer uses, and the reason the row above is now only what the THREAD is
  // (its source, its board, its projects).
  footer.appendChild(modelPicker)
  footer.appendChild(effortPicker)
  footer.appendChild(createModelEffortMenu({ modelSelect: modelPicker, effortSelect: effortPicker }).element)
  footer.appendChild(autopilotChip)

  const commandMenu = document.createElement('div')
  commandMenu.className = 'fl-newthread-commands'
  commandMenu.hidden = true
  shell.appendChild(commandMenu)

  /**
   * WHERE THIS THREAD'S WORK WILL LAND — the one decision, beside the model.
   *
   * It stands where an unlabelled "Branch name (optional)" box used to: a field
   * with no suggestion, no validation and no way to say "actually, work in the
   * project", while the other two thirds of the same decision were asked by two
   * further surfaces after the thread already existed. The chip is all three,
   * before anything is made, and every rule behind it lives in
   * `new-thread-branch.ts` where it can be tested (allowed-pattern #14).
   *
   * It sits on the message box's footer for the reason everything else there
   * does: these are settings for the turn this box is about to start.
   */
  const branchChip = createNewThreadBranchChip({ seed: () => branchSeed(draft) })
  footer.appendChild(branchChip.element)

  const submit = document.createElement('fl-button')
  submit.setAttribute('variant', 'primary')
  submit.setAttribute('small', '')
  submit.textContent = 'Create thread'
  submit.addEventListener('click', () => {
    if (!currentSubmitState().ready) return
    finish(withHunt(withBranch(draft)))
  })
  footer.appendChild(submit)

  // ── Projects ────────────────────────────────────────────────────────────
  // Chips, not a checklist. The modal stacked one row per project down the
  // dialog; a thread belongs to one project and occasionally borrows others, so
  // the common answer is already correct and the rest is a row you skim.
  const projectsRow = document.createElement('div')
  projectsRow.className = 'fl-newthread-projects'
  card.appendChild(projectsRow)

  const notice = document.createElement('p')
  notice.className = 'fl-newthread-hint'
  notice.hidden = true
  card.appendChild(notice)

  // ── Keys ────────────────────────────────────────────────────────────────
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      finish(null)
      return
    }
    // ⌘/Ctrl+Enter creates from anywhere on the page, including the textarea,
    // where a plain Enter has to stay a newline.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (currentSubmitState().ready) finish(withHunt(withBranch(draft)))
      return
    }
    // A plain Enter in a single-line field submits, the way it does in a dialog.
    if (event.key === 'Enter' && event.target !== description) {
      event.preventDefault()
      if (currentSubmitState().ready) finish(withHunt(withBranch(draft)))
    }
  })

  /**
   * The draft, plus the loop it was asked to run as.
   *
   * A COPY WITH THE SWITCH READ AT SUBMIT TIME. The control owns its own state;
   * mirroring it into `draft` on every keystroke would be a second copy that can
   * disagree with the one on screen.
   */
  function withHunt(current: ThreadDraft): ThreadDraft {
    const config = hunt.read()
    if (!config.on) return { ...current }
    return { ...current, hunt: { config, loop: hunt.targetLoop() } }
  }

  /**
   * The draft, plus what the chip decided.
   *
   * READ AT SUBMIT, for the same reason the hunt switch is: the control owns
   * its own state, and mirroring it into `draft` on every keystroke would be a
   * second copy that can disagree with the one on screen.
   *
   * WORKING IN THE PROJECT IS AN EMPTY ANSWER, NOT A DIFFERENT ONE.
   * `prepareRequestFor` answers `worktree: 'project'` for it, which becomes a
   * blank branch
   * and no start — which is precisely the draft every caller produced before
   * this control existed, so the create path needs no new branch of its own to
   * express "leave it alone".
   */
  function withBranch(current: ThreadDraft): ThreadDraft {
    const shape = prepareRequestFor(branchChip.choice(), branchSeed(current))
    if (shape.worktree === 'project') {
      const next: ThreadDraft = { ...current, branch: '' }
      // ABSENT, not present-and-empty: `start` says "this thread wants a branch
      // of its own", and a key sitting there holding nothing would say it.
      delete next.start
      // A thread in the project's own folder has no folder of its own to name.
      delete next.worktreeName
      return next
    }
    const next: ThreadDraft = { ...current, branch: shape.branch ?? '' }
    if (shape.start === undefined) delete next.start
    else next.start = shape.start
    // THE THIRD FIELD, WHICH THIS USED TO DROP. `prepareRequestFor` has always
    // returned it; nothing carried it, so every thread created here landed in a
    // directory named after its id however carefully the folder was named.
    if (shape.worktreeName === undefined) delete next.worktreeName
    else next.worktreeName = shape.worktreeName
    return next
  }


  /** A small square icon button for the box's footer. */
  function footerButton(icon: string, label: string, run: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'fl-newthread-icon'
    btn.title = label
    btn.setAttribute('aria-label', label)
    const glyph = document.createElement('fl-icon')
    glyph.setAttribute('name', icon)
    glyph.setAttribute('size', '13')
    btn.appendChild(glyph)
    btn.addEventListener('click', (event) => {
      event.preventDefault()
      run()
    })
    return btn
  }

  /**
   * Read picked files into the draft.
   *
   * Validation and the cap are the composer's, not a second opinion: the same
   * `validateAttachment` / `addAttachmentWithOutcome` that guard a message sent
   * from a live thread guard this one, because it IS a message sent from a live
   * thread — just one whose thread does not exist yet (allowed-pattern #14).
   */
  async function takeFiles(files: File[]): Promise<void> {
    for (const file of files) {
      const check = validateAttachment({ mediaType: file.type, byteSize: file.size })
      if (!check.ok) {
        setNotice(check.reason)
        continue
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      const dataBase64 = btoa(binary)
      const item: MessageAttachmentInput = {
        id: attachmentId(file.type, file.size, dataBase64.slice(0, 64)),
        mediaType: file.type,
        fileName: file.name,
        byteSize: file.size,
        dataBase64,
      }
      const outcome = addAttachmentWithOutcome(draft.attachments, item)
      draft.attachments = [...outcome.list]
      if (outcome.outcome === 'cap-reached') {
        setNotice(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} images per message.`)
      }
    }
    renderAttachments()
  }

  function renderAttachments(): void {
    attachRow.textContent = ''
    for (const item of draft.attachments) {
      const chip = document.createElement('span')
      chip.className = 'fl-newthread-attachment'
      const name = document.createElement('span')
      name.textContent = item.fileName
      name.className = 'fl-newthread-attachment-name'
      const drop = document.createElement('button')
      drop.type = 'button'
      drop.textContent = '×'
      drop.className = 'fl-newthread-attachment-drop'
      drop.setAttribute('aria-label', `Remove ${item.fileName}`)
      drop.addEventListener('click', () => {
        draft.attachments = [...removeAttachment(draft.attachments, item.id)]
        renderAttachments()
      })
      chip.append(name, drop)
      attachRow.appendChild(chip)
    }
    attachRow.hidden = draft.attachments.length === 0
  }

  /** The footer slash button — open the whole list (append mode), or close it. */
  function toggleCommands(): void {
    if (!commandMenu.hidden) {
      closeCommandMenu()
      return
    }
    renderCommandMenu(null, 'button')
  }

  /** Hide the list and forget which row was highlighted. */
  function closeCommandMenu(): void {
    commandMenu.hidden = true
    commandRows = []
    commandSelected = 0
  }

  /**
   * Reflect what is being typed into the / list. Called on every keystroke: the
   * moment the description reads `/` or `/word` the filtered list opens; the
   * moment it stops (a space, a second word, cleared text) a typed list closes.
   * A list the footer button opened is left alone — the person opened it on
   * purpose and is not typing a command.
   */
  function syncCommandMenu(): void {
    const match = COMMAND_RE.exec(description.value)
    if (match) {
      renderCommandMenu(match[1] ?? '', 'typed')
    } else if (commandMode === 'typed') {
      closeCommandMenu()
    }
  }

  /**
   * Rebuild the list for a query and show it. `filter === null` (the button)
   * shows everything; a typed query prefix-matches the command name. A typed
   * query that matches nothing closes the list rather than showing an empty box —
   * the footer button is the only opening that explains an empty project.
   */
  function renderCommandMenu(filter: string | null, mode: 'typed' | 'button'): void {
    commandMode = mode
    const query = (filter ?? '').toLowerCase()
    commandRows =
      filter === null
        ? [...commands]
        : commands
            .filter((command) => command.name.toLowerCase().startsWith(query))
            .slice(0, MAX_COMMAND_RESULTS)
    if (mode === 'typed' && commandRows.length === 0) {
      closeCommandMenu()
      return
    }
    commandSelected = 0
    commandMenu.textContent = ''
    if (commandRows.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'fl-newthread-commands-empty'
      // Says what is true rather than how to fix it (forbidden-pattern #12).
      empty.textContent = 'This project has no commands yet.'
      commandMenu.appendChild(empty)
    }
    commandRows.forEach((command, index) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'fl-newthread-command'
      const name = document.createElement('span')
      name.className = 'fl-newthread-command-name'
      name.textContent = `/${command.name}`
      row.appendChild(name)
      if (command.description) {
        const desc = document.createElement('span')
        desc.className = 'fl-newthread-command-desc'
        desc.textContent = command.description
        row.appendChild(desc)
      }
      // Hovering a row is choosing it, so keyboard Enter and a click agree.
      row.addEventListener('mousemove', () => setCommandSelection(index))
      row.addEventListener('click', () => pickCommand(command))
      commandMenu.appendChild(row)
    })
    paintCommandSelection()
    commandMenu.hidden = false
  }

  /** Move the highlight, clamped, and keep the highlighted row in view. */
  function moveCommandSelection(delta: number): void {
    if (commandRows.length === 0) return
    const next = commandSelected + delta
    setCommandSelection(Math.max(0, Math.min(commandRows.length - 1, next)))
  }

  function setCommandSelection(index: number): void {
    commandSelected = index
    paintCommandSelection()
  }

  function paintCommandSelection(): void {
    const rows = commandMenu.querySelectorAll<HTMLElement>('.fl-newthread-command')
    rows.forEach((row, index) => {
      const active = index === commandSelected
      row.classList.toggle('is-active', active)
      if (active) row.scrollIntoView({ block: 'nearest' })
    })
  }

  /**
   * Insert the chosen command into the DESCRIPTION — the first message, the only
   * field that gets sent, and the whole reason someone picked a command.
   *
   * TYPED mode replaces the `/query` under the caret with `/<name> ` via the
   * composer's own pure helper, so the two message boxes insert a command the
   * same way (allowed-pattern #14). BUTTON mode has no token to replace, so it
   * appends — on its own line when there is already text.
   */
  function pickCommand(command: SlashCommand): void {
    if (commandMode === 'typed') {
      const { text, caret } = computeCommandInsertion(description.value, command.name)
      description.value = text
      draft.description = text
      closeCommandMenu()
      description.focus()
      description.setSelectionRange(caret, caret)
    } else {
      const existing = description.value.trim()
      description.value = existing === '' ? `/${command.name} ` : `${existing}\n/${command.name} `
      draft.description = description.value
      closeCommandMenu()
      description.focus()
      description.setSelectionRange(description.value.length, description.value.length)
    }
    paintSubmit()
  }

  /**
   * A one-off message under the box — a rejected file, the attachment cap.
   *
   * Distinct from the submit reason, which is on the Create button: this is
   * something that JUST HAPPENED and has to be seen, so it earns a line; that
   * is a standing state and does not.
   */
  function setNotice(text: string): void {
    notice.textContent = text
    notice.hidden = text === ''
  }

  // ── Render ──────────────────────────────────────────────────────────────
  /** The submit rule, asked the same way from every place that needs it. */
  function currentSubmitState(): { ready: boolean; hint: string } {
    return submitState({
      ...draft,
      noun: 'thread',
      // Only "from scratch" is titleless — an import still needs its reference,
      // and passing a description there would arm Create with no issue named.
      ...(draft.source === 'manual' ? { description: draft.description } : {}),
    })
  }

  function paintSubmit(): void {
    // The suggested branch name follows what is being typed above it, for as
    // long as nobody has typed one of their own — so it repaints with the same
    // keystroke that repaints Create, and never lags a character behind.
    branchChip.refresh()
    const base = currentSubmitState()
    // The loop's own refusal counts like a missing field: switching it on and
    // naming no rule is a hunt with no way to end.
    const huntRefusal = hunt.refusal()
    const state =
      huntRefusal === null ? base : { ready: false, hint: huntRefusal }
    if (state.ready) submit.removeAttribute('disabled')
    else submit.setAttribute('disabled', '')
    /**
     * The reason lives on the BUTTON, not under the card.
     *
     * It used to be a line of text below the box — "Say what this thread is
     * about" — permanently on screen for the entire time the page was empty,
     * which is the whole time before anyone types. It read as a label for the
     * page rather than as the state of one control, and the page already says
     * what to do: an empty box with a placeholder in it.
     *
     * The rule it serves stands (forbidden-pattern #12: a control that cannot
     * act owes its reason in its own terms) — the reason is just attached to
     * the control it is about, where it costs no room and appears when someone
     * reaches for the thing that will not move.
     */
    submit.setAttribute('title', state.hint)
    submit.setAttribute('aria-disabled', String(!state.ready))
  }

  function render(): void {
    sourcePicker.value = draft.source
    // Hidden from scratch — see the field's own note. Shown, and required, for
    // the three imports.
    primaryField.hidden = draft.source === 'manual'
    if (draft.source !== 'manual') {
      primaryField.placeholder = SOURCE_PLACEHOLDER[draft.source]
      primaryField.value = draft.reference
      primaryField.setAttribute('aria-label', `${sourceLabel(draft.source)} reference`)
    }

    const board = taskCheckboxState({ source: draft.source, asTask: draft.asTask })
    boardChip.textContent = board.checked ? 'On the task board' : 'Not on the task board'
    boardChip.classList.toggle('is-on', board.checked)
    // Follows the board chip: off the board, there is no list for a hunt to
    // file into, so the switch is not offered and any hunt already configured
    // is switched off with it.
    hunt.setAvailable(board.checked)
    boardChip.disabled = board.disabled
    // A control that cannot act owes the reason in its own terms
    // (forbidden-pattern #12) — create-modal.ts writes that sentence.
    boardChip.title = board.hint
    boardChip.setAttribute('aria-pressed', String(board.checked))

    projectsRow.textContent = ''
    for (const root of roots) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'fl-newthread-chip'
      chip.textContent = projectName(root.rootPath)
      chip.title = root.rootPath
      const on = draft.roots.includes(root.rootPath)
      chip.classList.toggle('is-on', on)
      chip.setAttribute('aria-pressed', String(on))
      chip.addEventListener('click', () => {
        draft.roots = on
          ? draft.roots.filter((path) => path !== root.rootPath)
          : [...draft.roots, root.rootPath]
        render()
      })
      projectsRow.appendChild(chip)
    }
    projectsRow.hidden = roots.length < 2

    paintSubmit()
  }

  return {
    element,
    open(input) {
      // Settle any pending ask before starting a new one — see the interface.
      finish(null)
      roots = input.roots
      commands = input.commands ?? []
      // RESET, not carried over: a hunt switched on for the last thread must not
      // be silently on for the next one. `undefined` and an explicit null both
      // mean "not read yet", which the control renders as such.
      hunt.write(emptyHuntConfig())
      hunt.setLoops(input.loops ?? null)
      draft = {
        ...EMPTY_THREAD_DRAFT,
        roots: input.primary === null ? [] : [input.primary],
        attachments: [],
        effort: effortPicker.value,
        model: modelPicker.value,
      }
      description.value = input.prompt ?? ''
      draft.description = description.value
      // RESET, never carried over: the branch chosen for the last thread must
      // not be silently chosen for the next one. The project's branches are
      // dropped with it — `setBranches` refills them for whichever project this
      // page has just been opened for.
      branchChip.reset()
      branchChip.setBranches(null)
      branchChip.setProjectBranch(null)
      closeCommandMenu()
      setNotice('')
      renderAttachments()
      render()
      window.setTimeout(() => {
        // A seeded prompt is the thing to finish, so the caret goes to its end.
        if (description.value !== '' && draft.source === 'manual') {
          description.focus()
          description.setSelectionRange(description.value.length, description.value.length)
          return
        }
        primaryField.focus()
      }, 0)
      return new Promise<ThreadDraft | null>((resolve) => {
        settle = resolve
      })
    },
    setCommands(next) {
      commands = next
    },
    setLoops(next) {
      hunt.setLoops(next)
    },
    setBranches(next) {
      branchChip.setBranches(next)
      // The list's `current` IS the project's own branch, so the chip learns
      // both from one read rather than asking twice for one fact.
      branchChip.setProjectBranch(next?.current ?? null)
    },
    setWorktreeDefaults(next) {
      branchChip.setWorktreeDefaults(next)
    },
    setRuntimeModels(provider, extraModels, untestedModels) {
      rebuildModelPicker(provider, extraModels, untestedModels)
    },
    cancel() {
      finish(null)
    },
  }
}

let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    ${HUNT_CONFIG_STYLES}
    /* The hunt's configuration, directly under the settings row it belongs to. */
    .fl-newthread-hunt { padding: 0 2px; }
    .fl-newthread-hunt:empty { display: none; }
    .fl-newthread {
      display: flex;
      align-items: center;
      justify-content: center;
      /* FILL THE COLUMN. Its host is a flex container, so without this the page
         sized to its own content — the card's 620px — and then centred inside
         that, which put the whole thing against the left edge of a wide pane
         and looked like the centring was simply not applied. */
      flex: 1;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: auto;
      padding: var(--fl-space-lg);
      background: var(--fl-color-surface);
    }
    /* Bounded rather than fluid: a composer stretched across a wide editor is
       a line of text nobody can track back to the start of. */
    .fl-newthread-card {
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-sm);
      width: 100%;
      max-width: 620px;
      /* Narrower than the card's ideal width is a normal state here — the chat
         column starts around 320px — so it must be allowed to shrink, and the
         box inside it must not be pushed wider by its own footer. */
      min-width: 0;
    }
    .fl-newthread-settings {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      flex-wrap: wrap;
      padding: 0 var(--fl-space-xs);
    }
    /* Plain text with a chevron — the same treatment the composer's own model
       and effort pickers take, for the same reason: inside a page of controls,
       a box around each one is a second grid nobody asked for. */
    .fl-newthread-select {
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
    .fl-newthread-select:hover {
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
    }
    .fl-newthread-chip {
      height: 22px;
      padding: 0 var(--fl-space-sm);
      background: transparent;
      border: var(--fl-border-width) solid transparent;
      border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      white-space: nowrap;
      cursor: pointer;
    }
    .fl-newthread-chip:hover:not(:disabled) {
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
    }
    .fl-newthread-chip.is-on {
      background: var(--fl-color-accent-muted);
      color: var(--fl-color-accent);
    }
    .fl-newthread-chip:disabled { cursor: default; opacity: 0.7; }
    /* One box holding the whole question, like the chat composer it becomes. */
    .fl-newthread-shell {
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-xs);
      padding: var(--fl-space-sm);
      background: var(--fl-color-bg);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-lg);
    }
    .fl-newthread-shell:focus-within {
      border-color: var(--fl-color-focus-ring);
      box-shadow: 0 0 0 1px var(--fl-color-focus-ring);
    }
    .fl-newthread-title,
    .fl-newthread-body {
      width: 100%;
      background: transparent;
      border: none;
      outline: none;
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
    }
    .fl-newthread-title {
      padding: var(--fl-space-xs) var(--fl-space-sm);
      font-size: var(--fl-text-prose-size);
    }
    .fl-newthread-body {
      padding: 0 var(--fl-space-sm) var(--fl-space-xs);
      resize: none;
      min-height: 66px;
      font-size: var(--fl-text-ui-size);
      line-height: var(--fl-line-height);
    }
    .fl-newthread-title::placeholder,
    .fl-newthread-body::placeholder { color: var(--fl-color-text-secondary); }
    .fl-newthread-footer {
      display: flex;
      align-items: center;
      gap: var(--fl-space-xs);
      padding-left: var(--fl-space-sm);
      /* At the chat column's narrowest the branch chip and Create do not fit
         on one line; wrapping keeps the primary action inside the box rather
         than overflowing it (the lesson of #1469, in the composer). */
      flex-wrap: wrap;
      row-gap: var(--fl-space-xs);
    }
    .fl-newthread-projects {
      display: flex;
      align-items: center;
      gap: var(--fl-space-xs);
      flex-wrap: wrap;
      padding: 0 var(--fl-space-xs);
    }
    .fl-newthread-projects[hidden] { display: none; }
    .fl-newthread-hint {
      margin: 0;
      padding: 0 var(--fl-space-xs);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    .fl-newthread-hint[hidden] { display: none; }
    /* Footer icon buttons — square, glyph-only, the same treatment the
       composer's attach/capture controls take. */
    .fl-newthread-icon {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 22px;
      padding: 0;
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      cursor: pointer;
    }
    .fl-newthread-icon:hover {
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
    }
    .fl-newthread-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: var(--fl-space-xs);
      padding: 0 var(--fl-space-sm);
    }
    .fl-newthread-attachments[hidden] { display: none; }
    .fl-newthread-attachment {
      display: inline-flex;
      align-items: center;
      gap: var(--fl-space-xs);
      max-width: 200px;
      padding: 0 var(--fl-space-xs);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    .fl-newthread-attachment-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fl-newthread-attachment-drop {
      border: none;
      background: none;
      color: inherit;
      cursor: pointer;
      padding: 0 2px;
      font: inherit;
    }
    /* The / list. Inside the box, under the footer, so it reads as belonging to
       the message rather than floating over the page like a menu. */
    .fl-newthread-commands {
      display: flex;
      flex-direction: column;
      max-height: 200px;
      overflow-y: auto;
      margin-top: var(--fl-space-xs);
      border-top: var(--fl-border-width) solid var(--fl-color-separator);
      padding-top: var(--fl-space-xs);
    }
    .fl-newthread-commands[hidden] { display: none; }
    .fl-newthread-command {
      display: flex;
      align-items: baseline;
      gap: var(--fl-space-sm);
      width: 100%;
      padding: 4px var(--fl-space-sm);
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
      text-align: left;
      cursor: pointer;
    }
    .fl-newthread-command:hover,
    .fl-newthread-command.is-active { background: var(--fl-color-surface-raised); }
    .fl-newthread-command-name {
      flex: none;
      font-family: var(--fl-font-mono);
      color: var(--fl-color-accent);
    }
    .fl-newthread-command-desc {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    .fl-newthread-commands-empty {
      margin: 0;
      padding: 4px var(--fl-space-sm);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
  `
  document.head.appendChild(style)
}
