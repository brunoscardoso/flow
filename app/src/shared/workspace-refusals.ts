// THE ONE TABLE of what a person reads when a Workspace action is refused —
// read by main (the registry's refusal `detail`) and by the renderer (the
// settings' link steps), so the same refusal never reads two ways.
// No commands, paths or setting names (forbidden-pattern #12).

import { gitRemoteRefusalDetail } from './git-remote'
import type { WorkspaceRefusalReason } from './workspaces-contract'

/** The sentence a person reads for each refusal. No commands, paths or setting names (forbidden-pattern #12). */
export const WORKSPACE_REFUSAL_SENTENCES: Record<WorkspaceRefusalReason, string> = {
  'invalid-name': 'A Workspace needs a plain name with at least one letter or digit.',
  'invalid-remote': gitRemoteRefusalDetail('invalid-remote'),
  'insecure-remote': gitRemoteRefusalDetail('insecure-remote'),
  'credentials-in-url': gitRemoteRefusalDetail('credentials-in-url'),
  'no-workspace': 'There is no Workspace on this computer yet. Create or join one first.',
  'which-workspace': 'There is more than one Workspace on this computer. Choose the one this project joins.',
  'unknown-workspace': "That Workspace isn't on this computer.",
  'unknown-project': "That Workspace has no such project.",
  'not-a-git-repo': "That folder isn't the top of a git repository.",
  'unreadable-remote':
    "Flow can't read this project's repository address, so it can't match it to a Workspace project. Choose the project it is instead.",
  'committed-flow':
    "This project keeps its knowledge in its own history. Joining sets that copy aside in one commit, which needs your go-ahead first.",
  'dirty-code':
    'This project has changes that are not committed yet. Commit them or set them aside first, so the rename is the only change in its commit.',
  'keeps-own-knowledge-repo':
    'This project still keeps its knowledge in a repository of its own. Flow brings that knowledge into the Workspace when the project moves in.',
  'linked-elsewhere':
    'This project’s knowledge already lives in another Workspace, and a project’s knowledge lives in one place.',
  'malformed-workspace': "A Workspace on this computer can't be read.",
  // ABOUT A REPOSITORY, NOT THIS COMPUTER. Joining used to refuse with
  // 'malformed-workspace', whose sentence says "on this computer" — so pasting the
  // address of a repository that is not a Workspace sent the reader to look at their
  // own machine, where nothing was wrong. One reason code cannot answer for two
  // opposite subjects.
  'not-a-workspace-repo':
    "That repository doesn't hold a Workspace yet. A Workspace is made here and shared to an empty repository — join it once that has happened.",
  'malformed-local-map': "Flow's list of this computer's project folders can't be read.",
  'already-joined': 'This computer already has that Workspace.',
  'clone-failed': "The Workspace couldn't be fetched. Check the address and that you have access to it.",
  'commit-failed': "The move couldn't be committed, so the project's knowledge was put back as it was.",
  'invalid-description': 'A description is plain text, up to a few paragraphs long.',
  'sync-busy': 'The Workspace is syncing right now. Try again in a moment.',
  'invalid-roots': "Flow couldn't name those project folders to the Workspace.",
  'duplicate-name': 'Another Workspace on this computer already has that name. Choose another.',
  'same-workspace': 'That project is already in that Workspace.',
  'project-exists': 'That Workspace already has this project. Move or remove it there first.',
  'default-workspace': 'The Default Workspace stays — every project without another Workspace lives there.',
  unconfirmed: 'This needs your go-ahead first.',
  'remote-exists': 'This Workspace already shares through another repository. Choose Change to replace it.',
  'merge-in-progress': 'A sync of this Workspace was left half-done. Sync it first, then try again.',
  failed: "Flow couldn't finish that.",
  unavailable: "Flow couldn't reach its Workspace tools just now. Try again in a moment.",
}


/** The sentence for a refusal — the one wording, wherever it is reported. */
export function workspaceRefusalDetail(reason: WorkspaceRefusalReason): string {
  return WORKSPACE_REFUSAL_SENTENCES[reason]
}
