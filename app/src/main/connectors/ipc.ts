// Connector IPC channels — the renderer's whole route to connectors
// (plan_connectors, Phase 2).
//
// Every request is checked HERE and rebuilt field by field before it reaches
// the connector service: only the app window may call, a project root must be
// one the renderer may address (a thread's checkout is answered as its
// project), and an added config is rebuilt from the two shapes a person can
// type — nothing else the renderer sends is written into Claude's files. The
// service is the one owner (allowed-pattern #14); these handlers translate.

import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { ConnectorAddConfig, ConnectorIconTheme, ConnectorScope } from '../../shared/connectors'
import type { IpcInvokeChannel, IpcRequest, IpcResponse } from '../../shared/ipc-contract'
import { timed } from '../ipc/slow-handler'
import type { ConnectorConfig } from './connector-config-writer'
import type { ConnectorService } from './connector-service'
import type { ConnectorSuggester } from './connector-suggest'

export interface ConnectorChannelDependencies {
  service: Pick<
    ConnectorService,
    | 'listConnectors'
    | 'add'
    | 'remove'
    | 'setForThread'
    | 'reconnect'
    | 'setAskFirst'
    | 'icon'
    | 'signIn'
    | 'signOut'
    | 'cancelSignIn'
  >
  /** REQUIRED: the "Suggested for <project>" reader and its "Not now" writer. */
  suggestions: Pick<ConnectorSuggester, 'suggest' | 'dismiss'>
  /**
   * REQUIRED (allowed-pattern #26): the PROJECT root for a path the renderer
   * may address, or null when it may not address it at all.
   */
  resolveRoot: (rootPath: string) => string | null
  /** REQUIRED: only the app window's own top frame may manage connectors. */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

/** A refused request — the renderer sent something main will not act on. */
export class ConnectorRequestError extends Error {
  constructor(channel: string, what: string) {
    super(`${channel}: ${what}`)
    this.name = 'ConnectorRequestError'
  }
}

const MAX_FIELD_LENGTH = 4096
const MAX_ARGS = 64
const MAX_FINGERPRINTS_PER_CALL = 50
const SCOPES: ReadonlySet<string> = new Set<ConnectorScope>(['account', 'project-local', 'project-shared'])

function record(value: unknown, channel: string, field = 'request'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConnectorRequestError(channel, `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, channel: string, field: string): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_FIELD_LENGTH) {
    throw new ConnectorRequestError(channel, `${field} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, channel: string, field: string): string | undefined {
  return value === undefined || value === null ? undefined : requiredString(value, channel, field)
}

function boolean(value: unknown, channel: string, field: string): boolean {
  if (typeof value !== 'boolean') throw new ConnectorRequestError(channel, `${field} must be true or false`)
  return value
}

function scopeOf(value: unknown, channel: string): ConnectorScope {
  if (typeof value !== 'string' || !SCOPES.has(value)) throw new ConnectorRequestError(channel, 'scope is not known')
  return value as ConnectorScope
}

function themeOf(value: unknown, channel: string): ConnectorIconTheme {
  if (value !== 'light' && value !== 'dark') throw new ConnectorRequestError(channel, 'theme must be light or dark')
  return value
}

/**
 * The added config, rebuilt from the two shapes a person can type. A web
 * address must be http(s); a program is a command and its arguments. Env and
 * headers are never taken from the renderer.
 */
export function addConfigOf(value: unknown, channel: string): ConnectorConfig {
  const raw = record(value, channel, 'config') as Partial<Record<keyof ConnectorAddConfig | 'args' | 'command' | 'url', unknown>>
  const type = raw['type']
  if (type === 'http' || type === 'sse') {
    const url = requiredString(raw['url'], channel, 'config.url').trim()
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new ConnectorRequestError(channel, 'config.url is not an address')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ConnectorRequestError(channel, 'config.url must be a web address')
    }
    return { type, url }
  }
  if (type === 'stdio') {
    const command = requiredString(raw['command'], channel, 'config.command').trim()
    const argsRaw = raw['args']
    if (argsRaw === undefined || argsRaw === null) return { type: 'stdio', command }
    if (!Array.isArray(argsRaw) || argsRaw.length > MAX_ARGS) {
      throw new ConnectorRequestError(channel, 'config.args must be a short list')
    }
    const args = argsRaw.map((arg, index) => {
      if (typeof arg !== 'string' || arg.length > MAX_FIELD_LENGTH) {
        throw new ConnectorRequestError(channel, `config.args[${index}] must be text`)
      }
      return arg
    })
    return args.length === 0 ? { type: 'stdio', command } : { type: 'stdio', command, args }
  }
  throw new ConnectorRequestError(channel, 'config.type is not known')
}

export function registerConnectorChannels(deps: ConnectorChannelDependencies): () => void {
  const { service } = deps
  const registered: IpcInvokeChannel[] = []

  function rootOf(value: unknown, channel: string): string {
    const asked = requiredString(value, channel, 'projectRoot')
    const root = deps.resolveRoot(asked)
    if (root === null) throw new ConnectorRequestError(channel, 'unknown projectRoot')
    return root
  }

  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: Record<string, unknown>) => Promise<IpcResponse<C>> | IpcResponse<C>,
  ): void {
    registered.push(channel)
    ipcMain.handle(channel, (event, request: IpcRequest<C>) =>
      timed(channel, async (req: unknown) => {
        let trusted = false
        try {
          trusted = deps.isTrustedSender(event)
        } catch {
          trusted = false
        }
        if (!trusted) {
          console.warn('[Connectors] refused a call from outside the app window', { channel })
          throw new ConnectorRequestError(channel, 'not available here')
        }
        return handler(record(req ?? {}, channel))
      })(request),
    )
  }

  handle('connectors:list', (request) => {
    const channel = 'connectors:list'
    return service.listConnectors(rootOf(request['projectRoot'], channel), optionalString(request['threadId'], channel, 'threadId'))
  })

  handle('connectors:add', (request) => {
    const channel = 'connectors:add'
    return service.add(
      rootOf(request['projectRoot'], channel),
      scopeOf(request['scope'], channel),
      requiredString(request['name'], channel, 'name'),
      addConfigOf(request['config'], channel),
    )
  })

  handle('connectors:remove', (request) => {
    const channel = 'connectors:remove'
    // `confirmed` is passed through as sent: the service refuses anything but
    // the literal `true` (forbidden-pattern #15), so a missing flag does nothing.
    return service.remove(
      rootOf(request['projectRoot'], channel),
      scopeOf(request['scope'], channel),
      requiredString(request['name'], channel, 'name'),
      request['confirmed'],
    )
  })

  handle('connectors:setForThread', (request) => {
    const channel = 'connectors:setForThread'
    return service.setForThread(
      requiredString(request['threadId'], channel, 'threadId'),
      requiredString(request['name'], channel, 'name'),
      boolean(request['on'], channel, 'on'),
    )
  })

  handle('connectors:reconnect', (request) => {
    const channel = 'connectors:reconnect'
    return service.reconnect(
      rootOf(request['projectRoot'], channel),
      requiredString(request['name'], channel, 'name'),
      optionalString(request['threadId'], channel, 'threadId'),
    )
  })

  handle('connectors:setAskFirst', (request) => {
    const channel = 'connectors:setAskFirst'
    return service.setAskFirst(
      rootOf(request['projectRoot'], channel),
      requiredString(request['name'], channel, 'name'),
      requiredString(request['tool'], channel, 'tool'),
      boolean(request['on'], channel, 'on'),
    )
  })

  handle('connectors:icon', (request) => {
    const channel = 'connectors:icon'
    return service.icon(
      rootOf(request['projectRoot'], channel),
      requiredString(request['name'], channel, 'name'),
      themeOf(request['theme'], channel),
    )
  })

  handle('connectors:signIn', (request) => {
    const channel = 'connectors:signIn'
    return service.signIn(
      rootOf(request['projectRoot'], channel),
      requiredString(request['name'], channel, 'name'),
      optionalString(request['threadId'], channel, 'threadId'),
    )
  })

  handle('connectors:signOut', (request) => {
    const channel = 'connectors:signOut'
    // Passed through as sent: the service refuses anything but the literal
    // `true` (forbidden-pattern #15), so a missing flag signs nobody out.
    return service.signOut(
      rootOf(request['projectRoot'], channel),
      requiredString(request['name'], channel, 'name'),
      request['confirmed'],
      optionalString(request['threadId'], channel, 'threadId'),
    )
  })

  handle('connectors:cancelSignIn', (request) => {
    const channel = 'connectors:cancelSignIn'
    return service.cancelSignIn(rootOf(request['projectRoot'], channel), requiredString(request['name'], channel, 'name'))
  })

  handle('connectors:suggest', (request) => {
    const channel = 'connectors:suggest'
    return deps.suggestions.suggest(rootOf(request['projectRoot'], channel))
  })

  handle('connectors:dismissSuggestions', (request) => {
    const channel = 'connectors:dismissSuggestions'
    const raw = request['fingerprints']
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FINGERPRINTS_PER_CALL) {
      throw new ConnectorRequestError(channel, 'fingerprints must be a short, non-empty list')
    }
    const fingerprints = raw.map((item, index) => {
      const value = requiredString(item, channel, `fingerprints[${index}]`)
      if (!/^.+\|(repo|used|files)$/.test(value)) {
        throw new ConnectorRequestError(channel, `fingerprints[${index}] is not a suggestion`)
      }
      return value
    })
    return deps.suggestions.dismiss(rootOf(request['projectRoot'], channel), fingerprints)
  })

  return function disposeConnectorChannels(): void {
    for (const channel of registered) ipcMain.removeHandler(channel)
    registered.length = 0
  }
}
