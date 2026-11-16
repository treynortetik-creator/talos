// What git can be in the middle of, by the file or folder it keeps in the git dir while it is. Moving HEAD or rewriting
// files then would leave that half done (rollback.ts), or put back files under it (undo/restore.ts). Node builtins
// only, and nothing else: rollback.ts must load when the rest of the CLI cannot.
export const IN_PROGRESS: Array<[string, string]> = [
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase or a patch apply'],
  ['MERGE_HEAD', 'a merge'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
  ['sequencer', 'a cherry-pick or revert sequence'],
  ['BISECT_LOG', 'a bisect'],
]
