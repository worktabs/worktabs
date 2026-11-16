#!/bin/sh
# Process wrapper for the Claude Code extension in WSL (claudeCode.claudeProcessWrapper), which
# claude-wrap.exe is on Windows: claude-wrap <path-to-claude> <args...>
#
# claude replaces this script, so WORKTABS_PROC_ID (this process's id) is claude's own: it goes
# into every hook, where the app tells the extension panels' conversations apart, and the WSL
# agent watches it to see the panel's claude end. The app's hooks are given with --settings
# when WORKTABS_CLAUDE_SETTINGS names its settings file, so they apply to the sessions it
# manages only. Worktabs writes this file into the distribution.
WORKTABS_PROC_ID=$$
export WORKTABS_PROC_ID
# --settings goes right after claude's path, before the extension's arguments. claude takes it
# there as an option of its own, also in front of a subcommand, and rejects it after one: the
# extension runs "auth status --json" to check the sign-in, and
# "--setting-sources user workspace-trust --json" to ask whether the folder is trusted. Telling a
# session from a subcommand by its first argument failed on the latter. A subcommand starts no
# session, so the hooks in the file do not run there.
if [ -n "$WORKTABS_CLAUDE_SETTINGS" ] && [ $# -gt 0 ]; then
  claude=$1
  shift
  exec "$claude" --settings "$WORKTABS_CLAUDE_SETTINGS" "$@"
fi
exec "$@"
