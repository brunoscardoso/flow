/**
 * THE INSTALL PAYLOAD — built here, from values handed in, so the thing that
 * decides what a machine reports can be tested without being on that machine.
 *
 * Every field is named in `INSTALL_FIELDS`; the boundary refuses anything else,
 * so this module cannot widen the contract by being careless. What it CAN do is
 * read too much from the machine, which is why the reading happens in the
 * caller and arrives here as an argument.
 *
 * ── THE ID IS DERIVED, NOT COPIED ────────────────────────────────────────────
 *
 * `app_settings` already mints one identity per installation — `flow-ide-<hex>`
 * — and the plan is explicit that no second one should be minted beside it. But
 * that id is a COORDINATION NAME, and its own docstring says where it goes:
 * every loop claim writes it into a GitHub issue body, as
 * `<!-- loop-claim: flow-ide-3f2a9c1b7e04 @ ... -->`. On a public repository
 * that is public text.
 *
 * Sent verbatim, it would be a join key between "anonymous" telemetry and a
 * named repository — and through the repository, a person. Nothing in the
 * payload would name a project, and the promise would still be broken, because
 * the leak is not a field: it is the id being the SAME id.
 *
 * So the root stays single (nothing new is minted or stored) and what leaves is
 * a one-way function of it. Same installation, same value, every run; and no
 * way back to the word written in the issue.
 */

import { createHash } from 'node:crypto'
import type { InstallField } from '../../shared/telemetry-allowlist'

/**
 * What the MACHINE says about itself. Read by the caller, so this module can be
 * tested off the machine it describes.
 */
export interface MachineFacts {
  appVersion: string
  platform: string
  osVersion: string
  arch: string
  locale: string
  timezone: string
}

/**
 * The machine's facts plus the one the STORE owns.
 *
 * `firstRunAt` is kept separate up to this point because it comes from a
 * different place and has a different lifetime: the machine's answers change
 * when somebody upgrades or travels, and the first-run stamp never changes at
 * all. Merging them earlier would have meant a machine reader inventing a value
 * it cannot know.
 */
export type InstallFacts = MachineFacts & { firstRunAt: string }

export type InstallPayload = Partial<Record<InstallField, string>>

/**
 * A separator that cannot occur in the root id, so no two different roots can
 * produce the same pre-image. Belt and braces on a hash that is already
 * one-way.
 */
const TELEMETRY_ID_SALT = 'flow.telemetry.install.v1|'

/**
 * The installation's telemetry id: stable per install, not reversible to the
 * coordination name it is derived from.
 *
 * 16 hex characters. Long enough that collisions are not a real concern at any
 * plausible number of installs, short enough to read in a row of a table.
 */
export function telemetryInstallId(rootId: string): string {
  return createHash('sha256').update(`${TELEMETRY_ID_SALT}${rootId}`).digest('hex').slice(0, 16)
}

/**
 * Build the install payload.
 *
 * `sessionId` is the caller's — one per run of the app, minted at start — so
 * that "how many people this week" is answerable without anything durable
 * beyond the install id itself.
 */
export function installPayload(
  rootId: string,
  sessionId: string,
  facts: InstallFacts,
  /**
   * The signed-in person, when there is one.
   *
   * ABSENT IS THE NORMAL CASE and must stay absent rather than becoming an
   * empty string: "nobody has signed in" and "somebody signed in as nothing"
   * are different facts, and a receiving end that sees `""` cannot tell them
   * apart.
   */
  identityId?: string | null,
): InstallPayload {
  return {
    ...(identityId === undefined || identityId === null || identityId === ''
      ? {}
      : { identityId }),
    installId: telemetryInstallId(rootId),
    sessionId,
    appVersion: facts.appVersion,
    platform: facts.platform,
    osVersion: facts.osVersion,
    arch: facts.arch,
    locale: facts.locale,
    timezone: facts.timezone,
    firstRunAt: facts.firstRunAt,
  }
}
