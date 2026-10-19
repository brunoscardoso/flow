// TypeScript language-server adapter — the config entry that plugs
// typescript-language-server (LSP façade over tsserver) into the generic
// LspManager. Everything TS-specific lives here; the manager stays generic.
//
// Spawn strategy (in order):
//   1. Resolve `typescript-language-server/lib/cli.mjs` from app deps and run
//      it with a Node executable. Inside Electron, `process.execPath` is the
//      Electron binary, so ELECTRON_RUN_AS_NODE=1 turns it into plain Node —
//      no reliance on a `node` on PATH in a packaged app. In a plain Node
//      harness, `process.execPath` already IS node.
//   2. Fall back to `npx typescript-language-server --stdio` (dev machines
//      without the workspace install).
//
// TypeScript resolution: the server prefers the workspace's own typescript;
// `tsserver.fallbackPath` points at the app's bundled typescript so projects
// without a local install still get language features.
//
// Electron-free on purpose — the Node E2E harness imports this directly.

import { dirname } from 'path'

import type { LanguageServerConfig } from './lsp-manager'

export const TYPESCRIPT_SERVER_ID = 'typescript'

const TYPESCRIPT_FILE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const

const TYPESCRIPT_LANGUAGE_IDS: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
}

/** Any of these at a workspace root marks it as a JS/TS project. */
const TYPESCRIPT_ROOT_MARKERS = ['tsconfig.json', 'jsconfig.json', 'package.json']

function resolveOptional(specifier: string): string | null {
  try {
    return require.resolve(specifier)
  } catch {
    return null
  }
}

/** True when running inside Electron (main process). */
function isElectron(): boolean {
  return Boolean(process.versions.electron)
}

/**
 * Build the LanguageServerConfig for typescript-language-server. Call once at
 * boot and pass to `lspManager.registerServer()`.
 */
export function createTypeScriptServerConfig(): LanguageServerConfig {
  const serverModule = resolveOptional('typescript-language-server/lib/cli.mjs')
  const tsserverFallback = resolveOptional('typescript/lib/tsserver.js')

  let command: string
  let args: string[]
  let env: Record<string, string> | undefined

  if (serverModule) {
    command = process.execPath
    args = [serverModule, '--stdio']
    if (isElectron()) {
      env = { ELECTRON_RUN_AS_NODE: '1' }
    }
  } else {
    // Last resort for dev environments — requires npx on PATH.
    console.warn(
      '[LSP:typescript] typescript-language-server not resolvable from app deps; falling back to npx',
    )
    command = 'npx'
    args = ['typescript-language-server', '--stdio']
  }

  return {
    id: TYPESCRIPT_SERVER_ID,
    command,
    args,
    env,
    fileExtensions: [...TYPESCRIPT_FILE_EXTENSIONS],
    rootMarkers: [...TYPESCRIPT_ROOT_MARKERS],
    languageIds: { ...TYPESCRIPT_LANGUAGE_IDS },
    initializationOptions: {
      hostInfo: 'flow-ide',
      // Directory containing tsserver.js — used when the workspace has no
      // typescript of its own.
      ...(tsserverFallback
        ? { tsserver: { fallbackPath: dirname(tsserverFallback) } }
        : {}),
      preferences: {
        includeCompletionsForModuleExports: true,
        includeCompletionsWithInsertText: true,
      },
    },
  }
}
