// THE PICTURES ON A TICKET — the DOM half.
//
// A bug report is mostly its screenshot, and until now the card showed none of
// them: a Jira attachment never reached the description at all, and a GitHub
// body's `![](…)` was text in a renderer with no image support. Worse, neither
// COULD have been drawn — the page's policy is `img-src 'self' data:`, so a
// remote address in a ticket is not loadable here by design, and loosening that
// would let anyone who can comment on an issue beacon the reader.
//
// So the bytes come from main, one picture at a time, as data URIs the existing
// policy already permits (`integrations:imageData`). This file is only the
// strip: tiles, their four states, and a viewer for the one being looked at.

import {
  IMAGE_FETCH_CONCURRENCY,
  imageTileAction,
  imageTileCaption,
  inBatches,
  imagesSectionLabel,
  type TicketImageState,
} from './ticket-images-model'
import { markModalOverlay } from '../modal-overlay'
import type { IntegrationProvider, RemoteIssueImage } from '../../shared/ipc-contract'

export { imagesSectionLabel }

/** Fetch one picture's bytes. Injected so the strip is testable without IPC. */
export type ImageFetcher = (url: string) => Promise<{ dataUri: string | null; reason: string | null }>

/** The app's own fetcher — main holds the credential, so main does the asking. */
export function ipcImageFetcher(provider: IntegrationProvider): ImageFetcher {
  return async (url: string) => {
    const result = await window.flow.integrations.imageData({ provider, url })
    return { dataUri: result.dataUri, reason: result.reason }
  }
}

/**
 * Draw a ticket's pictures into `host`, filling each in as it arrives.
 *
 * Returns a promise that settles when every tile has stopped moving — the
 * caller does not have to await it (the strip paints its own progress), but a
 * test does.
 */
export function renderTicketImages(
  host: HTMLElement,
  images: readonly RemoteIssueImage[],
  fetchImage: ImageFetcher,
): Promise<void> {
  const strip = document.createElement('div')
  strip.className = 'fl-ticket-images'
  host.appendChild(strip)

  const tiles = images.map((image) => {
    const tile = document.createElement('button')
    tile.type = 'button'
    tile.className = 'fl-ticket-image is-loading'
    // A TILE IS BORN DISABLED. Until the bytes are here there is nothing to
    // open, and a control that looks pressable and does nothing is the silent
    // dead click this board has fixed too many times already.
    tile.disabled = true
    const frame = document.createElement('span')
    frame.className = 'fl-ticket-image-frame'
    const caption = document.createElement('span')
    caption.className = 'fl-ticket-image-caption'
    tile.append(frame, caption)
    strip.appendChild(tile)
    paint(tile, frame, caption, image, { kind: 'loading' })
    return tile
  })

  // NO `isConnected` GUARD, and the absence is the fix. The obvious
  // optimisation — skip a tile whose card has closed — was wrong twice over:
  // painting a detached node costs nothing, and every ticket dialog is BUILT
  // BEFORE IT IS MOUNTED, so at the moment the first batch is claimed none of
  // these tiles is in the document yet. Live against a four-screenshot Jira
  // ticket that behaved perfectly in every unit test, exactly
  // IMAGE_FETCH_CONCURRENCY tiles sat on "Loading…" for ever and the fourth —
  // claimed a second later, after the dialog was mounted — appeared normally.
  return inBatches(images, IMAGE_FETCH_CONCURRENCY, async (image, index) => {
    const tile = tiles[index]
    if (tile === undefined) return
    let state: TicketImageState
    try {
      const result = await fetchImage(image.url)
      state =
        result.dataUri === null
          ? { kind: 'failed', reason: result.reason ?? 'it could not be loaded' }
          : { kind: 'ready', dataUri: result.dataUri, bytes: result.dataUri.length }
    } catch (error) {
      state = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
    const frame = tile.querySelector('.fl-ticket-image-frame')
    const caption = tile.querySelector('.fl-ticket-image-caption')
    if (frame instanceof HTMLElement && caption instanceof HTMLElement) {
      paint(tile, frame, caption, image, state)
    }
  })
}

/** One tile, in whichever of its three states it is now. */
function paint(
  tile: HTMLButtonElement,
  frame: HTMLElement,
  caption: HTMLElement,
  image: RemoteIssueImage,
  state: TicketImageState,
): void {
  tile.classList.toggle('is-loading', state.kind === 'loading')
  tile.classList.toggle('is-failed', state.kind === 'failed')
  tile.disabled = state.kind !== 'ready'
  tile.title = imageTileCaption(image.name, state)
  tile.setAttribute('aria-label', imageTileAction(image.name, state))
  caption.textContent = image.name
  frame.textContent = ''
  if (state.kind === 'ready') {
    const img = document.createElement('img')
    // The alt is the picture's own name — what the author called it, or what
    // the tracker did. Never empty: an unlabelled image is nothing at all to
    // somebody reading with their ears.
    img.alt = image.name
    img.src = state.dataUri
    img.loading = 'lazy'
    frame.appendChild(img)
    tile.onclick = () => {
      openImageViewer(image.name, state.dataUri)
    }
    return
  }
  if (state.kind === 'failed') {
    // THE REASON IS THE TILE. A grey rectangle says "broken"; the sentence main
    // sent back says which credential expired, or that the attachment is gone.
    const why = document.createElement('span')
    why.className = 'fl-ticket-image-why'
    why.textContent = state.reason
    frame.appendChild(why)
  }
}

/**
 * The picture, full size, over everything else.
 *
 * ITS OWN LAYER, NOT AN EXPANDED TILE. The ticket dialog is a fixed 780×720
 * with one scroller, and growing a tile inside it would either stretch that
 * contract or show a screenshot at postage-stamp size. Escape closes the
 * viewer and NOT the ticket behind it — the listener captures, so the card's
 * own Escape handler never sees the key that was meant for this.
 */
export function openImageViewer(name: string, dataUri: string): () => void {
  const overlay = document.createElement('div')
  overlay.className = 'fl-ticket-viewer'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', name)
  overlay.tabIndex = -1
  // The one code path every focus/shortcut guard asks (#1430): while this is
  // open the panel shortcuts are inert, the terminal will not take focus, and
  // Tab is contained. Declared here, where the element is made.
  markModalOverlay(overlay)

  const img = document.createElement('img')
  img.src = dataUri
  img.alt = name
  const label = document.createElement('div')
  label.className = 'fl-ticket-viewer-name'
  label.textContent = name
  overlay.append(img, label)

  const previous = document.activeElement
  const close = (): void => {
    document.removeEventListener('keydown', onKey, true)
    overlay.remove()
    if (previous instanceof HTMLElement) previous.focus()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    // CAPTURE + STOP, in that order and on purpose: the ticket dialog under
    // this one also closes on Escape, and one keystroke must dismiss one thing.
    event.stopPropagation()
    event.preventDefault()
    close()
  }
  document.addEventListener('keydown', onKey, true)
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay || event.target === label) close()
  })
  document.body.appendChild(overlay)
  overlay.focus()
  return close
}

/**
 * The strip's styles.
 *
 * NO BACKTICKS ANYWHERE IN HERE, comments included — this is a template literal
 * and one ends it, with a TypeScript error pointing somewhere else entirely.
 */
export const TICKET_IMAGE_STYLES = `
  /* A ROW THAT WRAPS, not a grid: the tiles are a fixed size, and a ticket has
     between one and twelve of them. */
  .fl-ticket-images { display: flex; flex-wrap: wrap; gap: var(--fl-space-sm); }
  .fl-ticket-image {
    display: flex; flex-direction: column; gap: 4px; width: 148px;
    padding: 0; border: none; background: transparent;
    font-family: var(--fl-font-ui); text-align: left; cursor: pointer;
  }
  .fl-ticket-image:disabled { cursor: default; }
  .fl-ticket-image-frame {
    display: flex; align-items: center; justify-content: center;
    height: 96px; overflow: hidden;
    border: var(--fl-border-width) solid var(--fl-color-border);
    border-radius: var(--fl-radius-sm); background: var(--fl-color-surface);
  }
  /* COVER, not contain: a strip of thumbnails reads as a strip when the tiles
     are the same shape, and the full picture is one click away. */
  .fl-ticket-image-frame img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .fl-ticket-image:not(:disabled):hover .fl-ticket-image-frame { border-color: var(--fl-color-accent); }
  .fl-ticket-image:focus-visible .fl-ticket-image-frame { outline: 2px solid var(--fl-color-focus-ring); outline-offset: 1px; }
  .fl-ticket-image.is-loading .fl-ticket-image-frame { opacity: 0.6; }
  .fl-ticket-image-why {
    padding: 0 var(--fl-space-sm); font-size: var(--fl-text-caption-size);
    color: var(--fl-color-text-secondary); text-align: center; line-height: 1.35;
    overflow: hidden;
  }
  .fl-ticket-image-caption {
    font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .fl-ticket-image.is-failed .fl-ticket-image-caption { color: var(--fl-color-text-secondary); }

  /* The viewer sits above the ticket dialog, which is why the z-index is not
     simply one more than a card's. */
  .fl-ticket-viewer {
    position: fixed; inset: 0; z-index: 4000;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: var(--fl-space-sm); padding: var(--fl-space-xl);
    background: rgba(0, 0, 0, 0.82);
  }
  .fl-ticket-viewer img {
    max-width: 100%; max-height: calc(100% - 32px);
    object-fit: contain; border-radius: var(--fl-radius-sm);
  }
  .fl-ticket-viewer-name {
    color: #fff; font-size: var(--fl-text-caption-size); opacity: 0.85;
  }
`
