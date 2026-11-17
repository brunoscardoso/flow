/**
 * The chat-learn row, as an element (user decision 2026-11-17).
 *
 * Learning the area a conversation worked in is automatic; this row is how the
 * conversation says so. It paints ONE marker — the newest row main wrote for
 * that area — through `chatLearnCopy`, which owns every string. It is a quiet
 * status line (user, 2026-11-17: "more compacted, more clean"); its one door —
 * try again, after a failure — is injected so the element holds no IPC.
 */

import { chatLearnCopy, type ChatLearnMarker } from '../../shared/chat-learn-marker'

export interface ChatLearnCardDeps {
  retry: () => Promise<void>
  /** The in-chat question's answer (app-wide setting + this area). */
  answer: (enabled: boolean) => Promise<void>
}

/** Paint one marker into the row — first draw and every later phase. */
export function paintChatLearnCard(row: HTMLElement, marker: ChatLearnMarker, deps: ChatLearnCardDeps): void {
  const copy = chatLearnCopy(marker)
  row.dataset['phase'] = marker.phase
  row.dataset['module'] = marker.module

  const mark = document.createElement('span')
  mark.className = 'fl-chat-learn-mark'
  mark.setAttribute('aria-hidden', 'true')
  if (marker.phase !== 'learning') {
    const icon = document.createElement('fl-icon')
    icon.setAttribute('name', marker.phase === 'learned' ? 'check' : 'warning')
    icon.setAttribute('size', '12')
    mark.appendChild(icon)
  }
  const title = document.createElement('span')
  title.className = 'fl-chat-learn-title'
  title.textContent = copy.title
  const detail = document.createElement('span')
  detail.className = 'fl-chat-learn-detail'
  detail.textContent = copy.detail
  const nodes: Node[] = [mark, title, detail]

  const actionButton = (label: string, run: () => Promise<void>, primary = false): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = primary ? 'fl-chat-learn-action primary' : 'fl-chat-learn-action'
    button.textContent = label
    button.addEventListener('click', () => {
      for (const sibling of row.querySelectorAll<HTMLButtonElement>('.fl-chat-learn-action')) sibling.disabled = true
      void run().catch(() => {
        for (const sibling of row.querySelectorAll<HTMLButtonElement>('.fl-chat-learn-action')) sibling.disabled = false
      })
    })
    return button
  }
  if (copy.action?.kind === 'retry') nodes.push(actionButton(copy.action.label, deps.retry))
  if (copy.action?.kind === 'ask') {
    nodes.push(
      actionButton(copy.action.yes, () => deps.answer(true), true),
      actionButton(copy.action.no, () => deps.answer(false)),
    )
  }
  row.replaceChildren(...nodes)
}

/** One quiet line: mark, "Learned AppSidebar", "from 9 files". */
export function chatLearnCard(marker: ChatLearnMarker, deps: ChatLearnCardDeps): HTMLElement {
  injectStyles()
  const row = document.createElement('div')
  row.className = 'fl-chat-learn'
  row.setAttribute('role', 'status')
  paintChatLearnCard(row, marker, deps)
  return row
}

let stylesInjected = false

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = [
    '.fl-chat-learn {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  gap: 6px;',
    '  max-width: 100%;',
    '  height: 24px;',
    '  padding: 0 10px 0 8px;',
    '  border-radius: 999px;',
    '  background: var(--fl-color-surface-raised);',
    '  font-size: var(--fl-text-caption-size);',
    '  color: var(--fl-color-text-secondary);',
    '  white-space: nowrap;',
    '  overflow: hidden;',
    '}',
    '.fl-chat-learn-mark { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 12px; }',
    '.fl-chat-learn[data-phase="learning"] .fl-chat-learn-mark::before {',
    '  content: "";',
    '  width: 6px;',
    '  height: 6px;',
    '  border-radius: 50%;',
    '  background: var(--fl-color-accent);',
    '  animation: fl-chat-learn-pulse 1.4s ease-in-out infinite;',
    '}',
    '.fl-chat-learn[data-phase="learned"] .fl-chat-learn-mark { color: var(--fl-color-success); }',
    '.fl-chat-learn[data-phase="failed"] .fl-chat-learn-mark { color: var(--fl-color-warning); }',
    '@keyframes fl-chat-learn-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }',
    '@media (prefers-reduced-motion: reduce) {',
    '  .fl-chat-learn[data-phase="learning"] .fl-chat-learn-mark::before { animation: none; }',
    '}',
    '.fl-chat-learn-title { color: var(--fl-color-text); overflow: hidden; text-overflow: ellipsis; }',
    '.fl-chat-learn-detail { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }',
    '.fl-chat-learn[data-phase="ask"] { height: auto; min-height: 24px; padding: 3px 4px 3px 10px; border-radius: 14px; flex-wrap: wrap; white-space: normal; }',
    '.fl-chat-learn[data-phase="ask"] .fl-chat-learn-mark { display: none; }',
    '.fl-chat-learn-action.primary { padding: 2px 8px; border-radius: 999px; background: var(--fl-color-accent-muted); }',
    '.fl-chat-learn-action.primary:hover:not(:disabled) { text-decoration: none; background: var(--fl-color-accent-soft); }',
    '.fl-chat-learn-action {',
    '  flex: none;',
    '  margin-left: 2px;',
    '  padding: 0;',
    '  border: none;',
    '  background: transparent;',
    '  font: inherit;',
    '  color: var(--fl-color-accent);',
    '  cursor: pointer;',
    '}',
    '.fl-chat-learn-action:hover:not(:disabled) { text-decoration: underline; }',
    '.fl-chat-learn-action:disabled { opacity: 0.6; cursor: default; }',
  ].join('\n')
  document.head.append(style)
}
