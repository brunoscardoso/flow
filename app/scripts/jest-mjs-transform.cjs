// Jest transformer for the plain-JS modules under app/shared/.
//
// WHY THIS EXISTS. Those modules are `.mjs` on purpose: the uncompiled
// packaging scripts (`scripts/*.mjs`, plain Node ESM) and the TypeScript main
// process (bundled by electron-vite) must import the SAME file, or the SDK
// binary resolver and the bundle verifier can disagree about which native
// binary ships. Both of those consumers speak ESM natively. Jest here does
// not — it runs as CommonJS under Electron-as-Node (see scripts/run-jest.mjs),
// so a test that requires one of those modules gets a raw `export` token and
// a SyntaxError.
//
// WHY NOT ts-jest. Two reasons, both dead ends, recorded so nobody retries:
//   1. TypeScript derives a file's module format from its EXTENSION, not from
//      the `module` compiler option. `transpileModule` on a `.mjs` file emits
//      ESM even with `module: CommonJS` (verified against typescript 5.9) —
//      ts-jest simply cannot downlevel it. Renaming the file for the
//      transpile, as below, is what makes `module: CommonJS` apply.
//   2. A second ts-jest entry in `transform` with its own tsconfig silently
//      inherits the FIRST entry's compiler options: ts-jest caches one
//      ConfigSet per Jest project config (`TsJestTransformer._cachedConfigSets`
//      is keyed by the jest config alone, not by the transformer options).
//
// Scope: syntax-only module-format downlevel. No type checking happens here —
// the modules' types live in sibling `.d.mts` declarations, and the `.ts`
// files that import them are still fully checked by ts-jest (diagnostics: true)
// and by `npm run typecheck`.
const { createHash } = require('node:crypto')

const ts = require('typescript')

const COMPILER_OPTIONS = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
}

/** Bumped when the transform's output would change, to bust Jest's cache. */
const TRANSFORM_VERSION = '1'

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(sourceText, {
      compilerOptions: COMPILER_OPTIONS,
      // The `.ts` rename is the whole trick — see reason 1 above.
      fileName: sourcePath.replace(/\.mjs$/, '.ts'),
    })
    return { code: outputText }
  },

  getCacheKey(sourceText, sourcePath) {
    return createHash('sha1')
      .update(TRANSFORM_VERSION)
      .update('\0')
      .update(ts.version)
      .update('\0')
      .update(sourcePath)
      .update('\0')
      .update(sourceText)
      .digest('hex')
  },
}
