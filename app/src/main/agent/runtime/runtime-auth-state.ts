// A sign-in that stopped working, remembered for the session.
//
// The credential FILE is the honest answer to "is this signed in" right up
// until the moment the token behind it stops being accepted:
//
//   stream error: Failed to refresh token: 401 Unauthorized; retrying 1/5…
//
// ~/.codex/auth.json still holds tokens after that, so the check kept saying
// "✓ Signed in" while every turn was being rejected. A credential the runtime
// itself just refused is not a sign-in, whatever the file says.
//
// In memory only, and deliberately: the file is the durable truth, this is one
// observation on top of it. A successful turn clears it, so a transient outage
// heals itself the moment anything works.

const failures = new Map<string, number>()

/** The runtime rejected our credentials — its own words say unauthorized. */
export function markRuntimeAuthFailure(provider: string, at = Date.now()): void {
  failures.set(provider, at)
}

/** A turn worked, or a fresh sign-in landed: the observation is spent. */
export function clearRuntimeAuthFailure(provider: string): void {
  failures.delete(provider)
}

/** When this runtime last refused us, or null. */
export function runtimeAuthFailedAt(provider: string): number | null {
  return failures.get(provider) ?? null
}

/** Test-only: forget every observation. */
export function resetRuntimeAuthFailures(): void {
  failures.clear()
}
