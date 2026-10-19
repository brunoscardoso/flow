#!/usr/bin/env node
// Dev-only: make `npm run dev` show "Flow" (not "Electron") in the macOS menu
// bar + Dock.
//
// In development the bold application-menu title and the Dock tooltip come from
// the Electron BINARY's bundle name (CFBundleName in its Info.plist), which
// `app.setName('Flow')` cannot override — that only relabels the About/Hide/
// Quit items. The one lever in dev is to patch the dev Electron.app's Info.plist
// (and re-sign it, or arm64 macOS refuses to launch it). The PACKAGED Flow.app
// is unaffected: electron-builder builds its own bundle with productName "Flow".
//
// Idempotent + fail-soft: a no-op once the bundle already reads "Flow", silent
// on any non-macOS host or if the binary/PlistBuddy/codesign is unavailable.
// Runs automatically via the app's `predev` script; safe to run by hand too.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const APP_NAME = 'Flow'
if (process.platform !== 'darwin') process.exit(0)

const require = createRequire(import.meta.url)
let binPath
try {
  binPath = require('electron') // path to .../Electron.app/Contents/MacOS/Electron
} catch {
  process.exit(0)
}
if (typeof binPath !== 'string' || !binPath.includes('.app/')) process.exit(0)

const appDir = binPath.slice(0, binPath.indexOf('.app/') + 4) // .../Electron.app
const plist = join(appDir, 'Contents', 'Info.plist')
if (!existsSync(plist)) process.exit(0)

const PB = '/usr/libexec/PlistBuddy'
const read = (key) => {
  try {
    return execFileSync(PB, ['-c', `Print :${key}`, plist]).toString().trim()
  } catch {
    return ''
  }
}
// Already renamed — nothing to do (keeps `npm run dev` startup fast).
if (read('CFBundleName') === APP_NAME) process.exit(0)

const set = (key) => {
  try {
    execFileSync(PB, ['-c', `Set :${key} ${APP_NAME}`, plist])
  } catch {
    try {
      execFileSync(PB, ['-c', `Add :${key} string ${APP_NAME}`, plist])
    } catch {
      /* ignore — best effort */
    }
  }
}
set('CFBundleName')
set('CFBundleDisplayName')

// Editing Info.plist invalidates the bundle's ad-hoc signature; re-sign so
// arm64 macOS will still launch it.
try {
  execFileSync('codesign', ['--force', '--sign', '-', appDir], { stdio: 'ignore' })
} catch {
  /* ignore — unsigned dev binaries still launch on some setups */
}
console.log(`[dev-app-name] dev Electron bundle labelled "${APP_NAME}"`)
