/**
 * Progressive-learning renderer surface (#513 phase 2).
 *
 * A single, self-contained actionable card (bottom-right, FlowNotification-
 * style) that shows the one-time "Run a basic discovery?" ask when main pushes
 * `learn:basicDiscoveryAsk` for a root. The user's choice routes back through
 * `learn:answerBasicDiscovery`, which main persists (never re-asked) and, on
 * 'yes', turns into a basic-discovery request. One card at a time — a newer ask
 * replaces an older, unanswered one.
 *
 * Main asks ONLY about a project outside every Workspace (decision 2026-10-06):
 * a Workspace project gets its basic discovery automatically, and a thread on
 * it waits for that (main/learn/basic-discovery.ts) — see
 * `shouldAskBasicDiscovery`.
 */
import '../components'
import { learnCardBottom } from './card-placement'

const ASK_TITLE = 'Run a basic discovery?'
const ASK_BODY =
  'The agent reads your top-level modules and builds understanding on the blueprint.'

export function initLearn(): () => void {
  const api = window.flow
  if (!api?.learn) {
    console.warn('flow: preload bridge missing — progressive-learning ask disabled')
    return () => undefined
  }

  injectStyles()

  /** The live ask card, or null when none is showing. */
  let current: HTMLElement | null = null

  /** Stops the live card following the toast stack's height. */
  let stopPlacing: (() => void) | null = null

  const dismiss = (): void => {
    stopPlacing?.()
    stopPlacing = null
    current?.remove()
    current = null
  }

  /**
   * Stand the card on top of the notification toasts rather than over them
   * (card-placement.ts): they share a corner, and the card is drawn above.
   */
  const placeAboveToasts = (card: HTMLElement): (() => void) => {
    const stack = document.querySelector<HTMLElement>('.fl-flow-toasts')
    const place = (): void => {
      card.style.bottom = learnCardBottom(stack?.getBoundingClientRect().height ?? 0)
    }
    place()
    if (stack === null || typeof ResizeObserver === 'undefined') return () => undefined
    const observer = new ResizeObserver(place)
    observer.observe(stack)
    return () => observer.disconnect()
  }

  // #1358: the ask has no project lifecycle — it is created when a root
  // reports provisioning-ready and removed only when ANSWERED. Remove that
  // project before answering and the card stays on screen over a "No project"
  // window, still naming the deleted folder and still offering to spend an
  // agent run on it. Tie it to the root it names.
  //
  // This guards BOTH asks: the chat-learn card names a root the same way, and
  // deleting that project makes its offer just as dead.
  const unsubscribeRoots = api.project.onListChanged?.((roots) => {
    const rootId = current?.dataset['rootId']
    if (rootId === undefined) return
    if (!roots.some((root) => root.rootPath === rootId)) dismiss()
  })

  /** One card shape, two asks — the chat-learn prompt is the same affordance
   *  with different copy, so it must not become a second card implementation.
   *  `rootId` is part of the spec because every ask belongs to a project: it
   *  names that project on the card (#1170) and is what ties the card to the
   *  root whose removal dismisses it (#1358). */
  const show = (spec: {
    rootId: string
    title: string
    body: string
    yesLabel: string
    onAnswer: (value: 'yes' | 'no') => void
  }): void => {
    dismiss() // replace any older, unanswered card

    const card = document.createElement('fl-card')
    card.setAttribute('tone', 'accent')
    card.setAttribute('dense', '')
    card.className = 'fl-learn-card'

    const title = document.createElement('div')
    title.className = 'fl-learn-title'
    title.textContent = spec.title
    // #1170: name the project. The ask fires PER ROOT on that root's
    // provisioning-ready transition, and addRoot deliberately does not steal
    // the active project (#382) — so this card routinely belongs to a project
    // the user is not in, and answering it enqueues a real caged agent run over
    // THAT project's modules. Without the name, an ask for the background
    // project is indistinguishable from one for the project on screen.
    const project = document.createElement('div')
    project.className = 'fl-learn-project'
    project.textContent = projectName(spec.rootId)
    project.title = spec.rootId
    card.dataset['rootId'] = spec.rootId
    const body = document.createElement('div')
    body.className = 'fl-learn-body'
    body.textContent = spec.body

    const actions = document.createElement('div')
    actions.className = 'fl-learn-actions'

    const answer = (value: 'yes' | 'no'): void => {
      dismiss()
      spec.onAnswer(value)
    }

    const noBtn = document.createElement('fl-button')
    noBtn.setAttribute('variant', 'ghost')
    noBtn.setAttribute('small', '')
    noBtn.textContent = 'Not now'
    noBtn.addEventListener('click', () => answer('no'))

    const yesBtn = document.createElement('fl-button')
    yesBtn.setAttribute('variant', 'primary')
    yesBtn.setAttribute('small', '')
    yesBtn.textContent = spec.yesLabel
    yesBtn.addEventListener('click', () => answer('yes'))

    actions.append(noBtn, yesBtn)
    card.append(title, project, body, actions)
    document.body.appendChild(card)
    current = card
    stopPlacing = placeAboveToasts(card)
  }

  const unsubscribeBasic = api.learn.onBasicDiscoveryAsk(({ rootId }) =>
    show({
      rootId,
      title: ASK_TITLE,
      body: ASK_BODY,
      yesLabel: 'Run discovery',
      onAnswer: (value) => {
        void api.learn
          .answerBasicDiscovery({ rootId, answer: value })
          .catch((error: unknown) => console.error('flow: basic-discovery answer failed', error))
      },
    }),
  )

  // Chat-learn: raised when a conversation worked in an area the blueprint does
  // not understand. Main decides WHETHER to ask (once per thread, unlearned
  // areas only) — the renderer only presents it.
  const unsubscribeChat = api.learn.onChatLearnAsk?.(
    ({ rootId, modulePath, fileCount, parentName }) =>
      show({
        rootId,
        title: 'Learn what you just worked on?',
        body:
          `This conversation touched ${fileCount} file(s) in ${modulePath}, which the ` +
          `blueprint hasn't learned yet. Learning it adds it to the board` +
          (parentName === null ? '.' : ` under ${parentName}.`),
        yesLabel: 'Learn it',
        onAnswer: (value) => {
          void api.learn
            .answerChatLearn({ rootId, modulePath, answer: value })
            .catch((error: unknown) => console.error('flow: chat-learn answer failed', error))
        },
      }),
  )

  return () => {
    unsubscribeBasic()
    unsubscribeChat?.()
    unsubscribeRoots?.()
    dismiss()
  }
}

/** The project's display name — its path's last segment (#1170). */
function projectName(rootPath: string): string {
  const trimmed = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-learn-card {
      position: fixed;
      right: var(--fl-space-md);
      bottom: 32px;
      width: 340px;
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-sm);
      z-index: 1003;
    }
    .fl-learn-project {
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fl-learn-title {
      color: var(--fl-color-text);
      font-size: var(--fl-text-ui-size);
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-learn-body {
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    .fl-learn-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--fl-space-sm);
    }
  `
  document.head.appendChild(style)
}
