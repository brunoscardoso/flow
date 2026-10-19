// Whether an active-project change is a genuine SWITCH that must clear the Review
// panel's per-project draft/approval state (#281). It must fire only when the
// root actually changes — resetting on a same-project re-notification (or a
// background refresh) would wipe a commit message the user is mid-way typing.

export function isProjectSwitch(previousRoot: string | null, nextRoot: string | null): boolean {
  return nextRoot !== previousRoot
}
