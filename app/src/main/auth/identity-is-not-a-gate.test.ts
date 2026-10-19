/**
 * IDENTITY NEVER DECIDES WHO MAY RUN THE APP.
 *
 * The person shipping this said it plainly: sign-in is for knowing who your
 * users are — not entitlement, not a gate. The plan says the same from the
 * other side: signed out is a FULL state, not a degraded one, and someone who
 * never signs in has lost nothing.
 *
 * That is an easy promise to make and an easy one to erode. It erodes one
 * reasonable-looking line at a time — a feature that needs a name for a label,
 * a panel that hides a button for the signed-out, a sync that "obviously"
 * requires an account — and each of those is defensible on its own. The sum is
 * an app that quietly stopped working for people who declined.
 *
 * So the invariant is enforced rather than remembered (allowed-pattern #14): the
 * identity store has EXACTLY ONE consumer outside its own folder, and that
 * consumer is the telemetry join. Anything else that wants to read who is
 * signed in has to change this test first, in a diff somebody reads.
 *
 * This cannot prove the promise — a test that reads source cannot know what a
 * feature does with what it read. What it CAN do is make the gate impossible to
 * add by accident, which is how it would actually be added.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Names that mean "read the signed-in person". */
const IDENTITY_SYMBOLS = [
  'identityStore',
  'createMachineIdentityStore',
  'createIdentityStore',
  'StoredIdentity',
]

/** Where reading identity is the module's actual job. */
const OWNS_IDENTITY = 'src/main/auth/'

/**
 * The sites that may READ identity, named explicitly.
 *
 * `main/index.ts` is still the only one. That surprised me while writing the
 * sign-in surface and is worth recording: the settings IPC answers "who am I"
 * WITHOUT importing the store — it takes an injected dep that yields a subject
 * and a display name, so the store itself never reaches it. A second reader was
 * expected here and turned out not to be needed.
 *
 * ── THIS LIST GREW ONCE, DELIBERATELY (client-sign-in Phase 3) ──────────────
 *
 * It began as one site, with the renderer at zero. A sign-in surface cannot
 * exist under that rule, which is exactly what this test is for: the rule did
 * not quietly bend, it was re-stated in a diff somebody read.
 *
 * WHAT DID NOT CHANGE is the thing worth having. The renderer may now DISPLAY
 * who you are; it still may not BRANCH on it. Displaying a name changes nothing
 * about what the app will do for you, and that is the whole promise — identity
 * tells you who somebody is, never what they may have.
 *
 * ── AND ONCE MORE, DELIBERATELY (feature-view-sharing Phase 5) ──────────────
 *
 * `src/main/share/share-client.ts` reads the stored identity to put the session
 * token in the Authorization header of a request to the share host. Publishing
 * is a server feature that needs an owner; the app stays whole signed out.
 * Signed out, a share call answers "Sign in to share" — and that is the only
 * thing identity decides there. The local feature view, and every other
 * surface, does exactly what it did before. The token stays in main
 * (`token-never-crosses-ipc.test.ts`); the renderer gets share state.
 */
const READERS = ['src/main/index.ts', 'src/main/share/share-client.ts']

/** Kept for the messages below, which read better naming one file. */
const WIRING_SITE = 'src/main/index.ts'

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      out.push(...sourceFiles(full))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(relative(process.cwd(), full))
    }
  }
  return out
}

describe('identity is never a gate', () => {
  const files = sourceFiles(join(process.cwd(), 'src'))

  it('finds the source tree it is meant to be scanning', () => {
    // POSITIVE BEFORE ABSENCE (allowed-pattern #28). Every assertion below is
    // "no file does X"; a walk that returned nothing would pass all of them.
    expect(files.length).toBeGreaterThan(200)
    expect(files).toContain(WIRING_SITE)
    expect(files.some((f) => f.startsWith(OWNS_IDENTITY))).toBe(true)
  })

  it('is read in exactly one place outside the module that owns it', () => {
    const readers = files.filter((file) => {
      if (file.startsWith(OWNS_IDENTITY)) return false
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      return IDENTITY_SYMBOLS.some((symbol) => source.includes(symbol))
    })
    // A new entry here is not forbidden — it is a decision. Add the file AND
    // say in the diff what it does with the identity, because the promise this
    // guards is that it does not gate anything.
    expect(readers.sort()).toEqual([...READERS].sort())
  })

  it('is used at the wiring site only to name a person, never to decide', () => {
    const source = readFileSync(join(process.cwd(), WIRING_SITE), 'utf8')
    const lines = source.split('\n')
    const uses = lines
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => line.includes('identityStore') && !line.startsWith('*'))

    expect(uses.length).toBeGreaterThan(0)

    // A CONDITIONAL ON IDENTITY IS THE GATE ITSELF — but two things that look
    // like one are not:
    //
    //  · `?.` and `??` are reads of a value that may be absent, which is how an
    //    OPTIONAL identity must be read. A first cut flagged the legitimate
    //    `identityStore?.load()?.subject ?? null` for looking like a ternary.
    //  · `identityStore === null` asks whether the STORE was constructed — a
    //    build with no keychain has none — not whether anybody is signed in.
    //    Refusing to offer sign-in on a machine that cannot keep one is not a
    //    gate on identity; it is the absence of a feature nobody can use.
    //
    // What remains after both is the real thing: a branch on WHO somebody is.
    const branches = uses.filter(({ line }) => {
      const withoutAbsence = line.replace(/\?\?/g, '').replace(/\?\./g, '.')
      // A BRANCH ON WHO, not a branch on WHETHER THE STORE EXISTS. Both are
      // `if` statements mentioning `identityStore`; only the first is a gate.
      // The tell is what the condition actually asks about — reading a subject
      // or loading a record, rather than comparing the store to null.
      const isExistenceCheck = /identityStore\s*(===|!==)\s*null/.test(withoutAbsence)
      const asksWhoTheyAre = /\.load\s*\(|subject|displayName/.test(withoutAbsence)
      if (isExistenceCheck && !asksWhoTheyAre) return false
      return /\bif\s*\(/.test(withoutAbsence) || withoutAbsence.includes('?')
    })
    expect(branches.map((b) => `${WIRING_SITE}:${b.number} — ${b.line}`)).toEqual([])
  })

  // THE RENDERER MAY DISPLAY, AND MAY NOT DECIDE.
  //
  // This used to assert zero renderer references at all, which a sign-in
  // surface cannot satisfy. The replacement is the half that was always the
  // point: the renderer never sees the identity STORE, and never branches on
  // whether somebody is signed in.
  it('never reaches the identity store from the renderer or the preload', () => {
    const storeReaders = files.filter(
      (file) =>
        (file.startsWith('src/renderer/') || file.startsWith('src/preload/')) &&
        IDENTITY_SYMBOLS.some((symbol) =>
          readFileSync(join(process.cwd(), file), 'utf8').includes(symbol),
        ),
    )
    expect(storeReaders).toEqual([])
  })

  it('never lets the renderer BRANCH on whether somebody is signed in', () => {
    // A surface may draw a name. It may not decide what the app DOES because of
    // one — no `if (signedIn)`, no `signedIn ? a : b` gating a feature.
    //
    // ── IT FOLLOWS THE VALUE, NOT THE LINE ──────────────────────────────────
    //
    // The first cut looked for one line carrying both an auth channel and an
    // `if`. A plant defeated it in two lines — `const who = …whoAmI` then
    // `if (who)` — which is not a clever evasion, it is how anybody would
    // naturally write it. So this collects the names a file binds FROM an auth
    // channel, and then looks for branches on those names.
    //
    // It is still a regex reading source, and a determined author can defeat
    // it. That is not the job: the job is to make the gate impossible to add by
    // ACCIDENT, which is how it would actually be added.
    const AUTH_READ = /\bwhoAmI\b|\bauthAvailable\b|\bflowIdentity\b/
    const offenders: string[] = []
    for (const file of files) {
      if (!file.startsWith('src/renderer/')) continue
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      const lines = source.split('\n')
      const bound = new Set<string>()
      lines.forEach((line) => {
        if (!AUTH_READ.test(line)) return
        const binding = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line)
        if (binding?.[1] !== undefined) bound.add(binding[1])
      })
      lines.forEach((line, index) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return
        // EXISTENCE IS NOT IDENTITY — the distinction this file has now had to
        // make three times. `identityStore === null` asks whether a store was
        // constructed; `settings.whoAmI === undefined` asks whether a preload
        // is new enough to have the channel. Neither asks WHO anybody is, and a
        // detector that cannot tell them apart flags the careful code and
        // teaches people to delete it.
        const bare = line
          .replace(/\?\?/g, '')
          .replace(/\?\./g, '.')
          .replace(/\b[\w.]*(?:whoAmI|authAvailable)\s*(?:===|!==)\s*undefined/g, 'CHANNEL_EXISTS')
        const namesAnIdentity =
          AUTH_READ.test(bare) || [...bound].some((name) => new RegExp(`\\b${name}\\b`).test(bare))
        if (!namesAnIdentity) return
        // A BINDING IS NOT A BRANCH. `const who = await whoAmI()` reads it;
        // `if (who)` decides with it.
        if (/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(bare)) return
        if (/\bif\s*\(/.test(bare) || bare.includes('?')) {
          offenders.push(`${file}:${index + 1} — ${trimmed.slice(0, 80)}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
