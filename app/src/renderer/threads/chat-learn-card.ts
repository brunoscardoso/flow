/**
 * The chat-learn row, as an element (user decision 2026-11-17).
 *
 * Learning the area a conversation worked in is automatic; this row is how the
 * conversation says so. It paints ONE marker — the newest row main wrote for
 * that area — through `chatLearnCopy`, which owns every string. Its two doors
 * (open the board, try again) are injected so the element holds no IPC.
 */

import { chatLearnCopy, type ChatLearnMarker } from '../../shared/chat-learn-marker'

export interface ChatLearnCardDeps {
  openBoard: () => void
  retry: () => Promise<void>
}

export function chatLearnCard(marker: ChatLearnMarker, deps: ChatLearnCardDeps): HTMLElement {
  injectStyles()
  const copy = chatLearnCopy(marker)
  const row = document.createElement('div')
  row.className = 'fl-chat-learn'
  row.dataset['phase'] = marker.phase
  row.dataset['module'] = marker.module

  const mark = document.createElement('span')
  mark.className = 'fl-chat-learn-mark'
  mark.setAttribute('aria-hidden', 'true')
  if (marker.phase !== 'learning') {
    const icon = document.createElement('fl-icon')
    icon.setAttribute('name', marker.phase === 'learned' ? 'check' : 'warning')
    icon.setAttribute('size', '14')
    mark.appendChild(icon)
  }

  const body = document.createElement('div')
  body.className = 'fl-chat-learn-body'
  const title = document.createElement('p')
  title.className = 'fl-chat-learn-title'
  title.textContent = copy.title
  const detail = document.createElement('p')
  detail.className = 'fl-chat-learn-detail'
  detail.textContent = copy.detail
  body.append(title, detail)

  if (copy.action !== null) {
    const action = copy.action
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-chat-learn-action'
    button.textContent = action.label
    button.addEventListener('click', () => {
      if (action.kind === 'board') {
        deps.openBoard()
        return
      }
      button.disabled = true
      void deps.retry().catch(() => {
        button.disabled = false
      })
    })
    body.appendChild(button)
  }

  row.append(mark, body)
  return row
}

let stylesInjected = false

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = [
    '.fl-chat-learn {',
    '  display: flex;',
    '  align-items: flex-start;',
    '  gap: var(--fl-space-sm);',
    '  padding: var(--fl-space-sm) var(--fl-space-md);',
    '  border: var(--fl-border-width) solid var(--fl-color-border);',
    '  border-radius: var(--fl-radius-row);',
    '  background: var(--fl-color-surface);',
    '}',
    '.fl-chat-learn-mark {',
    '  flex: none;',
    '  display: inline-flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  width: 16px;',
    '  height: 18px;',
    '}',
    '.fl-chat-learn[data-phase="learning"] .fl-chat-learn-mark::before {',
    '  content: "";',
    '  width: 8px;',
    '  height: 8px;',
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
    '.fl-chat-learn-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }',
    '.fl-chat-learn-title { margin: 0; color: var(--fl-color-text); }',
    '.fl-chat-learn-detail {',
    '  margin: 0;',
    '  color: var(--fl-color-text-secondary);',
    '  font-size: var(--fl-text-caption-size);',
    '}',
    '.fl-chat-learn-action {',
    '  align-self: flex-start;',
    '  margin-top: var(--fl-space-xs);',
    '  font: inherit;',
    '  font-size: var(--fl-text-caption-size);',
    '  color: var(--fl-color-accent);',
    '  background: transparent;',
    '  border: var(--fl-border-width) solid var(--fl-color-border);',
    '  border-radius: var(--fl-radius-sm);',
    '  padding: 3px var(--fl-space-sm);',
    '  cursor: pointer;',
    '}',
    '.fl-chat-learn-action:hover:not(:disabled) { border-color: var(--fl-color-accent); }',
    '.fl-chat-learn-action:disabled { opacity: 0.6; cursor: default; }',
  ].join('\n')
  document.head.append(style)
}
