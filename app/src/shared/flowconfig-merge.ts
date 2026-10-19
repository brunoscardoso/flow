// The app's door onto THE ONE flowconfig merge algorithm.
//
// The algorithm itself lives in `src/cli/state/flowconfig-merge.ts` at the repo
// root, where the CLI writes `.flowconfig` from `planflow-ai flow set`. The app
// writes the same file from its settings panel, and for years it did so with
// its OWN copy of the merge — two copies of one algorithm, differing in exactly
// the ways a person only discovers by losing a comment (allowed-pattern #14).
//
// So this file re-exports rather than reimplements. It exists at all because
// `app/` and the CLI are separate TypeScript projects: every main-process module
// imports through `@shared`/relative shared paths, and one file reaching across
// the workspace boundary is easier to keep honest than a dozen.
export { mergeFlowconfig, parseFlowconfigKeys } from '../../../src/cli/state/flowconfig-merge'
