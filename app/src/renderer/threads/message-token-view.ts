/**
 * Renders message tokens (message-tokens.ts) as DOM — text nodes and spans,
 * never HTML parsed from the content. A span holds exactly its token's text,
 * so a rendered message's textContent (and what a copy puts on the clipboard)
 * is the original message, character for character.
 */

import { isKnownCommand } from './command-names'
import { tokenizeMessage, type MessageToken } from './message-tokens'

const TOKEN_CLASS: Record<Exclude<MessageToken['kind'], 'text'>, string> = {
  command: 'fl-token fl-token-command',
  file: 'fl-token fl-token-file',
}

/** Replace `target`'s children with `tokens`. */
export function renderMessageTokens(target: HTMLElement, tokens: readonly MessageToken[]): void {
  injectTokenStyles()
  const fragment = document.createDocumentFragment()
  for (const token of tokens) {
    if (token.kind === 'text') {
      fragment.appendChild(document.createTextNode(token.text))
      continue
    }
    const span = document.createElement('span')
    span.className = TOKEN_CLASS[token.kind]
    span.textContent = token.text
    fragment.appendChild(span)
  }
  target.replaceChildren(fragment)
}

/** Tokenize `text` against the known commands and render it into `target`. */
export function renderHighlightedText(target: HTMLElement, text: string): void {
  renderMessageTokens(target, tokenizeMessage(text, isKnownCommand))
}

let tokenStylesInjected = false

function injectTokenStyles(): void {
  if (tokenStylesInjected) return
  tokenStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    /* A command looks like it does in the slash list — the code font and the
       accent — on a soft accent ground; a file mention is a quiet neutral grey. */
    .fl-token {
      font-family: var(--fl-font-mono);
      font-size: 0.92em;
      padding: 1px 4px;
      border-radius: 4px;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }
    .fl-token-command {
      color: var(--fl-color-accent);
      background: var(--fl-color-accent-soft);
    }
    .fl-token-file {
      color: var(--fl-color-mention);
      background: var(--fl-color-mention-soft);
    }
  `
  document.head.appendChild(style)
}
