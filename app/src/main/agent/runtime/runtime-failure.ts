// What to say in the transcript when a runtime's turn fails.
//
// The chat IS a transcript, so the tool's own words belong here in a way they
// never belonged in Settings — but they belong AFTER a sentence that says what
// happened. Measured on this machine, a Codex turn ends with:
//
//   ERROR codex_core::config: Failed to deserialize overridden config:
//   unknown variant `xhigh`, expected one of `low`, `medium`, `high`, `none`
//   in `model_reasoning_effort`
//
// Nothing in that names the actual situation: an old binary and a settings file
// written for a newer one. Every headless run dies the same way, whatever the
// prompt, so a reader could try ten different messages before suspecting the
// tool rather than themselves.

/** Does this output describe a tool that could not read its own config? */
export function isConfigFailure(output: string): boolean {
  return /failed to deserialize|error loading configuration|failed to (parse|load) config|unknown variant/i.test(
    output,
  )
}

/**
 * A turn's failure, said plainly, with the tool's own words kept after it.
 *
 * `name` is the runtime's display name — a line in a transcript has to say who
 * is talking.
 */
export function describeRuntimeFailure(name: string, output: string): string {
  const detail = output.trim().replace(/\s+/g, ' ')
  if (isAuthFailure(detail)) {
    return (
      `${name} rejected the sign-in Flow is using, so the turn never started. ` +
      `Sign in to ${name} again from Settings. — ${detail}`
    )
  }
  if (isConfigFailure(detail)) {
    return (
      `${name} could not read its own settings file, so the turn never started. ` +
      `This usually means ${name} is older than something in that file. ` +
      `Updating it normally fixes it. — ${detail}`
    )
  }
  return `${name}: ${detail}`
}

/**
 * Does this output say our credentials were refused?
 *
 * Measured: `Failed to refresh token: 401 Unauthorized` from Codex's stream
 * while ~/.codex/auth.json still held a full set of tokens. The file cannot
 * know this; only the runtime can say it.
 */
export function isAuthFailure(output: string): boolean {
  return /\b401\b|unauthorized|failed to refresh token|invalid[_ ]api[_ ]key|not logged in|authentication failed|token (has )?expired/i.test(
    output,
  )
}
