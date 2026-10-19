// Local release install — dogfood main WITHOUT publishing.
//
// Builds the EXACT release artifact (the same electron-builder pipeline a
// shipped build goes through — bundled CLI, real packaging, not `npm run dev`)
// and installs it where the OS keeps an installed Flow. No GitHub, no feed, no
// public timestamps.
//
// Two platforms, one shape — build the release payload, replace the installed
// copy, relaunch:
//
//   macOS    ad-hoc signed .app  →  ditto into /Applications
//   Windows  NSIS setup.exe      →  run it silently (per-user, no elevation)
//
// The Windows half goes through the INSTALLER rather than copying
// `win-unpacked` into %LOCALAPPDATA% by hand, and that is the whole design
// decision: the installer owns the Start Menu and desktop shortcuts, the
// uninstall entry, and the replacement of a previous install. Copying the
// payload over an installed Flow would delete its uninstaller and leave a dead
// Add/Remove Programs entry pointing at a directory nobody manages. It also
// means this command exercises the artifact Windows users actually run, which
// has no CI covering it (see docs/windows-verification-checklist.md).
//
// Versioning: the build is stamped `<next-patch>-local.<stamp>` so
//   - it reads HIGHER than the published version (electron-updater never
//     "updates" you back down to the public build), and
//   - LOWER than the next real release (shipping v<next-patch> later upgrades
//     over it normally).
// NOTHING IS PATCHED. The version reaches electron-builder as
// `-c.extraMetadata.version`, which overrides the packaged metadata without
// touching a tracked file. The earlier design wrote the stamp INTO
// package.json for the length of the build and restored it after, and every
// failure that design can have, it had:
//
//   • a run killed mid-build left the file EMPTY (writeFileSync truncates
//     first), and every npm command in the workspace then died with
//     `JSONParseError: Unexpected end of JSON input` — including the one that
//     would have restored it;
//   • a kill after the write leaked the stamp into git, because `process.on
//     ('exit')` does not fire on every Windows kill path;
//   • and anything else touching that file DURING a build changed the version
//     electron-builder read. Observed live: an unrelated `git checkout` of
//     package.json mid-run produced `Flow-0.1.10-x64-setup.exe` while this
//     script went looking for the `-local.<stamp>` name it had written, and
//     the build was discarded at the last step.
//
// On Windows the ordering buys nothing — `win.publish` is null, so there is no
// feed to out-rank — but the stamp still names which local build is installed,
// and one version scheme beats two.
//
// Usage:  npm run install:local        (from app/)

import { execFileSync, execSync } from 'node:child_process'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { distributableBuildConfig, LOCAL_SECRETS_FILE } from './build-config.mjs'

const IS_MAC = process.platform === 'darwin'
const IS_WINDOWS = process.platform === 'win32'

if (!IS_MAC && !IS_WINDOWS) {
  console.error(
    `install-local refused: macOS and Windows only (running on ${process.platform}) — ` +
      `there is no Linux target in electron-builder.yml to install.`,
  )
  process.exit(1)
}

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')

// THE SAME CONFIGURATION A RELEASE COMPILES IN — read from app/build-config.json
// (committed) and app/.flow-build.local.json (per machine), never from whatever
// the shell happens to export. Before this, a local install silently built an
// app with sign-in and sharing switched off.
const buildConfig = distributableBuildConfig(appDir)
if (buildConfig.problems.length > 0 || (buildConfig.missing.length > 0 && process.env.FLOW_RELEASE_WITHOUT_TELEMETRY !== '1')) {
  console.error('install-local refused:')
  for (const problem of buildConfig.problems) console.error(`  - ${problem}`)
  if (buildConfig.missing.length > 0) {
    console.error('  - build-time configuration missing — this app would offer no sign-in, sharing or telemetry:')
    for (const [name, what] of buildConfig.missing) console.error(`      ${name} (${what})`)
    console.error(`    public values belong in app/build-config.json; the ingest key in app/${LOCAL_SECRETS_FILE}`)
    console.error('    ({ "FLOW_TELEMETRY_KEY": "..." }), or say FLOW_RELEASE_WITHOUT_TELEMETRY=1 on purpose')
  }
  process.exit(1)
}

const run = (cmd, env = {}) =>
  execSync(cmd, { cwd: appDir, stdio: 'inherit', env: { ...process.env, ...buildConfig.values, ...env } })

/** Block the thread without `sleep`, which Windows does not have. */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
// The release part only. A tree that still carries a `-local.<stamp>` from the
// old patching design (or a hand-edit) must not compound it into
// `0.1.11-local.X-local.Y`, so the suffix is dropped before the bump.
const baseVersion = pkg.version.split('-')[0]
const [major, minor, patch] = baseVersion.split('.').map(Number)
if ([major, minor, patch].some(Number.isNaN)) {
  console.error(`install-local: cannot parse version "${pkg.version}" — fix app/package.json first`)
  process.exit(1)
}
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
const localVersion = `${major}.${minor}.${patch + 1}-local.${stamp}`

console.log(`install-local: building Flow v${localVersion} (release pipeline, no publish)`)

run('node scripts/verify-agent-binary.mjs')
run('npm run build:cli')
run('npx electron-vite build')

// THE VALUES ACTUALLY LANDED — checked in the bundle, as release does.
{
  const bundle = readFileSync(join(appDir, 'out/main/index.js'), 'utf8')
  const absent = Object.entries(buildConfig.values)
    .filter(([, value]) => value !== '' && !bundle.includes(value))
    .map(([name]) => name)
  if (absent.length > 0) {
    console.error(`install-local refused: the build did not compile in ${absent.join(', ')}`)
    process.exit(1)
  }
  console.log(`install-local: build-time configuration verified in the bundle (${Object.keys(buildConfig.values).filter((name) => buildConfig.values[name] !== '').length} values)`)
}

// THE VERSION, WITHOUT TOUCHING THE FILE. `extraMetadata` overrides the
// packaged package.json for this build only; the tracked file is never written,
// so there is nothing to restore and nothing to leak.
const versionArg = `-c.extraMetadata.version=${localVersion}`

if (IS_MAC) {
  run(`npx electron-builder --mac --dir -c.mac.identity=null ${versionArg}`, {
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  })
  run('node scripts/verify-agent-binary.mjs "dist/mac-arm64/Flow.app"')
  run('node scripts/verify-package-contents.mjs "dist/mac-arm64/Flow.app"')
} else {
  // `nsis` only — the portable target is a second full package of the same
  // payload and nothing here installs it. Unsigned is expected: `win` leaves
  // forceCodeSigning at false, so electron-builder logs one skip notice.
  run(`npx electron-builder --win nsis --x64 ${versionArg}`)
  run('node scripts/verify-agent-binary.mjs --target win32-x64 "dist/win-unpacked"')
  run('node scripts/verify-package-contents.mjs "dist/win-unpacked"')
}

// The build above compiled the ingest key into app/out. Rebuild it without the
// key now, exactly as release does, so the key does not sit in the working tree
// any longer than it has to. The packaged app keeps its own copy.
//
// app/out is NO LONGER TRACKED (2026-10-14), so `git add -A` can no longer
// publish it and this is defence in depth rather than the only guard it was.
try {
  execSync('npx electron-vite build', { cwd: appDir, stdio: 'ignore', env: { ...process.env, FLOW_TELEMETRY_KEY: '' } })
  const key = buildConfig.values.FLOW_TELEMETRY_KEY ?? ''
  const after = readFileSync(join(appDir, 'out/main/index.js'), 'utf8')
  if (key.length > 8 && after.includes(key)) {
    console.error('install-local: WARNING — the ingest key is still in app/out; do NOT commit it')
  }
} catch {
  console.error('install-local: WARNING — could not rebuild app/out without the ingest key; do NOT commit it')
}

if (IS_MAC) installMac()
else installWindows()

function installMac() {
  const built = join(appDir, 'dist', 'mac-arm64', 'Flow.app')
  if (!existsSync(built)) {
    console.error(
      'install-local: build produced no Flow.app — aborting before touching /Applications',
    )
    process.exit(1)
  }

  // Quit the running app (fail-soft — maybe it isn't running), swap, relaunch.
  try {
    execSync(`osascript -e 'tell application "Flow" to quit'`, { stdio: 'ignore', timeout: 15_000 })
    sleepSync(2000)
  } catch {
    /* not running */
  }
  const target = '/Applications/Flow.app'
  rmSync(target, { recursive: true, force: true })
  execSync(`ditto "${built}" "${target}"`)
  execSync(`open -a "${target}"`)
  console.log(`install-local: Flow v${localVersion} installed to /Applications and launched`)
}

function installWindows() {
  const setup = join(appDir, 'dist', `Flow-${localVersion}-x64-setup.exe`)
  if (!existsSync(setup)) {
    console.error(`install-local: build produced no installer at ${setup} — nothing was installed`)
    process.exit(1)
  }

  quitFlowWindows()

  // `/S` is NSIS's silent switch; electron-builder's assisted installer honours
  // it and, with perMachine:false + allowElevation:false, installs per-user
  // without a UAC prompt. It also replaces a previous install in place.
  console.log('install-local: running the installer silently (per-user, no elevation)…')
  try {
    execFileSync(setup, ['/S'], { stdio: 'inherit', timeout: 10 * 60_000 })
  } catch (error) {
    console.error(`install-local: the installer failed — ${error.message}`)
    console.error(`  the artifact is intact; run it by hand:  ${setup}`)
    process.exit(1)
  }

  // NSIS returns before the copy is necessarily finished settling.
  const installed = waitForInstalledExe(30_000)
  if (!installed) {
    console.error('install-local: the installer reported success but Flow.exe is not where')
    console.error('  a per-user install puts it, and no uninstall entry names another')
    console.error(`  location. The artifact is intact: ${setup}`)
    process.exit(1)
  }

  execFileSync('cmd', ['/c', 'start', '""', installed], { stdio: 'ignore' })
  console.log(`install-local: Flow v${localVersion} installed to ${dirname(installed)} and launched`)
}

/** Close a running Flow so the installer can replace its files. Fail-soft. */
function quitFlowWindows() {
  try {
    execFileSync('taskkill', ['/IM', 'Flow.exe'], { stdio: 'ignore' })
    sleepSync(2000)
  } catch {
    /* not running */
  }
  try {
    execFileSync('taskkill', ['/IM', 'Flow.exe', '/F'], { stdio: 'ignore' })
  } catch {
    /* already gone — the graceful close worked */
  }
}

/**
 * The installed Flow.exe, or null. Polls because NSIS exits before the last
 * file lands. Checks the per-user default first, then asks the registry —
 * `allowToChangeInstallationDirectory` means a previous install may have gone
 * somewhere else, and a silent re-install reuses that directory.
 */
function waitForInstalledExe(timeoutMs) {
  const localAppData = process.env['LOCALAPPDATA']
  const fallback = localAppData ? join(localAppData, 'Programs', 'Flow', 'Flow.exe') : null

  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fallback && existsSync(fallback)) return fallback

    const recorded = installedExeFromRegistry()
    if (recorded && existsSync(recorded)) return recorded

    if (Date.now() >= deadline) return null
    sleepSync(500)
  }
}

/**
 * Flow.exe as named by the per-user uninstall key electron-builder writes.
 *
 * Read off a real install rather than assumed: the key holds NO
 * `InstallLocation`. What it does hold is `DisplayIcon` (`<dir>\Flow.exe,0`)
 * and `UninstallString` (`"<dir>\Uninstall Flow.exe" /currentuser`), so the
 * directory is recovered from one of those. The key name is a GUID, so the
 * blocks are matched on `DisplayName` instead.
 */
function installedExeFromRegistry() {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )

    /** @type {Record<string, string>[]} */
    const blocks = []
    let current = null
    for (const line of out.split(/\r?\n/)) {
      if (/^HKEY_/.test(line)) {
        current = {}
        blocks.push(current)
        continue
      }
      const value = /^\s+(\S+)\s+REG_[A-Z_]+\s+(.*?)\s*$/.exec(line)
      if (value && current) current[value[1]] = value[2]
    }

    for (const block of blocks) {
      if (!/^Flow(\s|$)/.test(block['DisplayName'] ?? '')) continue

      const icon = (block['DisplayIcon'] ?? '').split(',')[0].trim()
      if (/flow\.exe$/i.test(icon)) return icon

      const uninstaller = /"([^"]+)"/.exec(block['UninstallString'] ?? '')
      if (uninstaller) return join(dirname(uninstaller[1]), 'Flow.exe')
    }
  } catch {
    /* no key yet, or reg unavailable — the default path is the answer */
  }
  return null
}
