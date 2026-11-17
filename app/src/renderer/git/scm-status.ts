/**
 * The Source Control half of the status line, bottom-left: the branch (with a
 * '*' when the tree is dirty — click shows Source Control) and the sync state
 * (↓N ↑M — click runs the same Sync the commit button runs). The blocked /
 * inbox cluster on the right is flow/status-line.ts and is untouched.
 */
import '../components'

export interface ScmStatusData {
  branch: string
  detached: boolean
  dirty: boolean
  ahead: number
  behind: number
  /** The branch tracks an upstream (else the sync item offers to publish). */
  hasUpstream: boolean
  /** A sync is running. */
  syncing: boolean
}

export interface ScmStatusLine {
  update(data: ScmStatusData | null): void
}

export function createScmStatusLine(
  statusBar: HTMLElement,
  actions: { onShowSourceControl(): void; onSync(): void },
): ScmStatusLine {
  injectStyles()
  const host = document.createElement('span')
  host.className = 'fl-scm-status'
  host.hidden = true

  const branch = document.createElement('button')
  branch.type = 'button'
  branch.className = 'fl-scm-status-item fl-scm-branch'
  const branchIcon = document.createElement('fl-icon')
  branchIcon.setAttribute('name', 'git-branch')
  branchIcon.setAttribute('size', '12')
  const branchText = document.createElement('span')
  branchText.className = 'fl-scm-branch-name'
  branch.append(branchIcon, branchText)
  branch.addEventListener('click', () => actions.onShowSourceControl())

  const sync = document.createElement('button')
  sync.type = 'button'
  sync.className = 'fl-scm-status-item fl-scm-sync'
  const syncIcon = document.createElement('fl-icon')
  syncIcon.setAttribute('name', 'sync')
  syncIcon.setAttribute('size', '12')
  const syncText = document.createElement('span')
  syncText.className = 'fl-scm-sync-counts'
  sync.append(syncIcon, syncText)
  sync.addEventListener('click', () => actions.onSync())

  host.append(branch, sync)
  statusBar.prepend(host)

  return {
    update(data) {
      if (data === null) {
        host.hidden = true
        return
      }
      host.hidden = false
      const name = data.detached ? 'detached HEAD' : data.branch || 'no branch'
      branchText.textContent = `${name}${data.dirty ? '*' : ''}`
      branch.title = data.dirty
        ? `${name}, with uncommitted changes. Show Source Control`
        : `${name}. Show Source Control`
      sync.hidden = data.detached
      sync.disabled = data.syncing
      syncIcon.classList.toggle('fl-scm-spinning', data.syncing)
      if (data.hasUpstream) {
        syncText.textContent = `${data.behind}↓ ${data.ahead}↑`
        sync.title =
          data.behind === 0 && data.ahead === 0
            ? 'In sync with the remote'
            : `Sync Changes: ${data.behind} to pull, ${data.ahead} to push`
      } else {
        syncText.textContent = ''
        sync.title = 'Publish Branch'
      }
    },
  }
}

let injected = false

function injectStyles(): void {
  if (injected) return
  injected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-scm-status { display: inline-flex; align-items: center; gap: 2px; margin-left: -4px; }
    .fl-scm-status[hidden] { display: none; }
    .fl-scm-status-item {
      display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 6px;
      border: 0; border-radius: 3px; background: transparent; color: inherit;
      font: inherit; cursor: pointer; white-space: nowrap;
    }
    .fl-scm-status-item:hover:not(:disabled) { background: var(--fl-color-surface-raised); color: var(--fl-color-text); }
    .fl-scm-status-item[hidden] { display: none; }
    .fl-scm-branch-name { max-width: 28ch; overflow: hidden; text-overflow: ellipsis; }
    .fl-scm-sync-counts { font-variant-numeric: tabular-nums; }
    @keyframes fl-scm-spin { to { transform: rotate(360deg); } }
    .fl-scm-spinning { animation: fl-scm-spin 1s linear infinite; }
  `
  document.head.appendChild(style)
}
