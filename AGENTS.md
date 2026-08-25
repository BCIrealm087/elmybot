# Codex working instructions

This branch, `codex-platform-separation`, was created from `platform-separation` to begin Codex-assisted work on Elmybot's platform separation.

For the current effort:

- Work only on `codex-platform-separation`.
- Do not commit or push changes directly to `platform-separation`, `master`, or any other branch.
- Before making changes, verify that the active branch is `codex-platform-separation`.
- Assume there will be no persisted scheduler jobs or guild/group configuration when changes from this branch are deployed or tested. Backward compatibility and data migration for both kinds of persisted data are out of scope; their persistence schemas may be redesigned from an empty state.
