// In-app auto-update (#auto-update). Wraps electron-updater's `autoUpdater`,
// translating its event stream into the single `UpdateStatus` shape the renderer
// banner consumes, and exposing check / download / install as explicit steps.
//
// UX: autoDownload is OFF — a newer version surfaces as an "available" banner and
// only downloads when the user opts in ("Do you want to update?"). Once
// downloaded it stages for the next launch (autoInstallOnAppQuit) and the banner
// offers "Restart to update".
//
// macOS reality: Squirrel.Mac validates the downloaded update's code signature
// against the running app, so auto-update only works for a signed + notarized
// build. On an unsigned/dev build a check errors — surfaced as an `error` status,
// never a crash. index.ts only auto-checks when app.isPackaged.

import type { AppUpdater } from 'electron-updater'
import { clampPercent, type UpdateStatus } from '../../shared/updater'

/**
 * Resolve electron-updater's platform updater, or null when it cannot be
 * created.
 *
 * `electron-updater`'s `autoUpdater` is a GETTER that builds the platform
 * updater on first touch — and that constructor THROWS when the app version
 * isn't valid semver (`ERR_UPDATER_INVALID_VERSION`). An unpackaged launch
 * reports `"0.0"`, so merely importing the binding took down the entire main
 * process before any window was created:
 *
 *     [Main] Fatal: failed to bootstrap main process:
 *     Error: App version is not a valid semver version: "0.0"
 *
 * That contradicts this module's own contract, stated at the top: a check on
 * an unsigned/dev build "is surfaced as an `error` status, NEVER a crash".
 * The crash happened before any check could run.
 *
 * The updater is optional chrome. It must never be the reason the app fails
 * to start.
 */
function resolveAutoUpdater(): AppUpdater | null {
  try {
    // Required lazily AND read inside the try: the throw is in the getter.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('electron-updater') as { autoUpdater: AppUpdater }
    return mod.autoUpdater
  } catch {
    return null
  }
}

/** Pushes a status to every renderer (typically the ipc broadcast helper). */
export type UpdateBroadcast = (status: UpdateStatus) => void

export class UpdaterManager {
  #status: UpdateStatus = { phase: 'idle' }
  #version: string | undefined
  readonly #broadcast: UpdateBroadcast
  /** null when electron-updater could not be constructed (see above). */
  readonly #updater: AppUpdater | null

  /**
   * Told that an update attempt failed — the rate, never the reason.
   *
   * Optional and unaware of what it is wired to: this module reports that
   * something went wrong, and whoever built it decides whether anybody counts
   * it. The message stays here; it names a host and sometimes a path, and it
   * is exactly what the telemetry contract rules out.
   */
  readonly #onFailed: (() => void) | undefined

  constructor(broadcast: UpdateBroadcast, onFailed?: () => void) {
    this.#broadcast = broadcast
    this.#onFailed = onFailed

    const autoUpdater = resolveAutoUpdater()
    this.#updater = autoUpdater
    if (autoUpdater === null) {
      // Unavailable, not broken: the app runs, updates simply aren't offered.
      this.#status = { phase: 'error', message: 'Updates are unavailable in this build.' }
      return
    }

    // One turn at a time; the user drives download/install explicitly.
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => this.#set({ phase: 'checking' }))
    autoUpdater.on('update-available', (info) => {
      this.#version = info.version
      this.#set({
        phase: 'available',
        version: info.version,
        notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
      })
    })
    autoUpdater.on('update-not-available', () => this.#set({ phase: 'not-available' }))
    autoUpdater.on('download-progress', (progress) =>
      this.#set({
        phase: 'downloading',
        version: this.#version,
        percent: clampPercent(progress.percent),
      }),
    )
    autoUpdater.on('update-downloaded', (info) => {
      this.#version = info.version
      this.#set({ phase: 'downloaded', version: info.version })
    })
    autoUpdater.on('error', (error) => this.#fail(error))
  }

  /** The last broadcast status (also returned by the `updater:check` handler). */
  get status(): UpdateStatus {
    return this.#status
  }

  /** Poll the feed for a newer version. Errors resolve to an `error` status. */
  async check(): Promise<UpdateStatus> {
    if (this.#updater === null) return this.#status
    try {
      await this.#updater.checkForUpdates()
    } catch (error) {
      this.#fail(error)
    }
    return this.#status
  }

  /** Download the available update in the background (progress via status events). */
  async download(): Promise<void> {
    if (this.#updater === null) return
    try {
      await this.#updater.downloadUpdate()
    } catch (error) {
      this.#fail(error)
    }
  }

  /** Quit and apply a downloaded update. No-op until `phase === 'downloaded'`. */
  install(): void {
    if (this.#status.phase !== 'downloaded' || this.#updater === null) return
    // isSilent=false, isForceRunAfter=true — relaunch into the new version.
    this.#updater.quitAndInstall(false, true)
  }

  #set(status: UpdateStatus): void {
    this.#status = status
    this.#broadcast(status)
  }

  #fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.#set({ phase: 'error', message })
    // THE FACT, NOT THE MESSAGE. A caller may count that updates are failing;
    // `message` stays on this machine.
    try {
      this.#onFailed?.()
    } catch {
      // Reporting a failure must not become one.
    }
  }
}
