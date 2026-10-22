#!/bin/sh
# Process wrapper for the Claude Code extension in WSL (claudeCode.claudeProcessWrapper), which
# claude-wrap.exe is on Windows: claude-wrap <path-to-claude> <args...>
#
# claude replaces this script, so WORKTABS_PROC_ID (this process's id) is claude's own: it goes
# into every hook, where the app tells the extension panels' conversations apart, and the WSL
# agent watches it to see the panel's claude end. The app's hooks are added with --settings
# when WORKTABS_CLAUDE_SETTINGS names its settings file, so they apply to the sessions it
# manages only. Worktabs writes this file into the distribution.
WORKTABS_PROC_ID=$$
export WORKTABS_PROC_ID
# A subcommand (the extension runs "auth status --json" to check the sign-in) rejects
# --settings after it, and starts no session for the hooks anyway. ${2--} is "-" when claude
# is given no arguments.
if [ -n "$WORKTABS_CLAUDE_SETTINGS" ]; then
  case "${2--}" in
    -*) exec "$@" --settings "$WORKTABS_CLAUDE_SETTINGS" ;;
  esac
fi
exec "$@"
