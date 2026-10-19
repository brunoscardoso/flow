// Types for should-build.mjs — plain JS so Vercel can run it with `node` before
// any build step; this lets the TypeScript tests import it with checking.

export declare const DEPLOY_PATHS: readonly string[]
export declare const COMPARE_FILE_CAP: number

export interface CompareResult {
  ok: boolean
  status?: string
  files?: Array<{ filename: string; previous_filename?: string }>
  error?: string
}

export declare function affectsDeploy(path: string): boolean

export declare function decide(
  env: { previousSha?: string; commitSha?: string; token?: string },
  compare: CompareResult | null,
): { build: boolean; reason: string }

export declare function fetchCompare(input: {
  owner: string
  repo: string
  base: string
  head: string
  token: string
  fetchFn?: typeof fetch
}): Promise<CompareResult>
