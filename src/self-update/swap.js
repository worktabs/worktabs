// The swap that runs after the app quits: wait for it and for everything started from its folder
// to exit, move the app aside, move the new one into its place, and start it. Windows does not
// let a folder be renamed while a program in it runs (claude-wrap.exe runs for every
// conversation), so it cannot happen while the app runs. It is a script of the system's own
// shell, as neither version of the app can run while their folders are renamed.
//
// The script writes { version, ok, error } to `result` for the next start to show.

const POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
# The values (swapCommand), which the app it starts does not get.
$values = $env:WORKTABS_SWAP | ConvertFrom-Json
Remove-Item -LiteralPath Env:WORKTABS_SWAP
$AppPid = $values.pid; $AppDir = $values.appPath; $Staged = $values.staged; $Container = $values.container
$Old = $values.old; $Version = $values.version; $Result = $values.result; $Relaunch = $values.relaunch; $Tries = $values.tries
function Write-Result($ok, $message) {
  @{ version = $Version; ok = $ok; error = $message } | ConvertTo-Json -Compress |
    Set-Content -LiteralPath $Result -Encoding UTF8
}
function Move-Retrying($from, $to) {
  # Antivirus and the search indexer hold files for a moment after a program exits. A rename
  # moves the whole folder or nothing. Move-Item moves the files one by one when the folder
  # cannot be renamed, stops at the one held, and on the next try moves the rest into the
  # half-filled destination, which leaves neither version whole.
  for ($i = 1; $i -lt $Tries; $i++) {
    try { [IO.Directory]::Move($from, $to); return } catch { Start-Sleep -Milliseconds 500 }
  }
  try { [IO.Directory]::Move($from, $to) } catch { throw $_.Exception.GetBaseException() }
}
function Start-App {
  if ($Relaunch) { Start-Process -FilePath (Join-Path $AppDir 'Worktabs.exe') -WorkingDirectory $AppDir }
}
function Fail($message) {
  Write-Result $false $message
  Remove-Item -LiteralPath $Container -Recurse -Force -ErrorAction SilentlyContinue
  Start-App
  exit 1
}
try { Wait-Process -Id $AppPid -Timeout 120 -ErrorAction SilentlyContinue } catch {}
$prefix = $AppDir.TrimEnd('\') + '\'
$deadline = (Get-Date).AddMinutes(2)
while ($true) {
  $left = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
  if ($left.Count -eq 0) { break }
  if ((Get-Date) -gt $deadline) { Fail ('Still running: ' + (($left | ForEach-Object { $_.Name } | Sort-Object -Unique) -join ', ')) }
  Start-Sleep -Seconds 1
}
if (Test-Path -LiteralPath $Old) { Remove-Item -LiteralPath $Old -Recurse -Force }
try { Move-Retrying $AppDir $Old } catch { Fail $_.Exception.Message }
try { Move-Retrying $Staged $AppDir } catch {
  $message = $_.Exception.Message
  try { Move-Retrying $Old $AppDir } catch { $message += ' ' + $_.Exception.Message }
  Fail $message
}
# The installer's entry in "Apps & features" shows the version it installed.
Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object {
  $entry = Get-ItemProperty -LiteralPath $_.PSPath
  $location = [string]$entry.InstallLocation
  $uninstall = [string]$entry.UninstallString
  if (($location -and $location.TrimEnd('\') -ieq $AppDir.TrimEnd('\')) -or $uninstall.ToLower().Contains($prefix.ToLower())) {
    Set-ItemProperty -LiteralPath $_.PSPath -Name DisplayVersion -Value $Version
  }
}
Write-Result $true ''
Start-App
Remove-Item -LiteralPath $Old -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $Container -Recurse -Force -ErrorAction SilentlyContinue
`;

// Without its comments and indentation: cmd takes at most 8191 characters (swapCommand), and
// -EncodedCommand is almost three times as long as the script.
const POWERSHELL_ENCODED = Buffer.from(
  POWERSHELL.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).join('\n'), 'utf16le',
).toString('base64');

// On macOS a running program does not hold its folder, so only the app's own exit is waited for.
// Errors are a step's name: sh has no JSON, and the app words them. `open` does not pass this
// environment on, so a separate data folder (WORKTABS_DATA_DIR) goes with --env, and -n starts
// this app even when another copy of Worktabs runs from elsewhere.
const SH = String.raw`
pid=$1 app=$2 staged=$3 container=$4 old=$5 version=$6 result=$7 relaunch=$8
start_app() {
  [ "$relaunch" = 1 ] || return 0
  if [ -n "$WORKTABS_DATA_DIR" ]; then open -n --env "WORKTABS_DATA_DIR=$WORKTABS_DATA_DIR" "$app"; else open -n "$app"; fi
}
finish() {
  printf '{"version":"%s","ok":%s,"error":"%s"}\n' "$version" "$1" "$2" > "$result"
}
fail() {
  finish false "$1"
  rm -rf "$container"
  start_app
  exit 1
}
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt 240 ] && fail wait
  sleep 0.5
done
rm -rf "$old"
mv "$app" "$old" || fail move
if ! mv "$staged" "$app"; then
  mv "$old" "$app"
  fail move
fi
xattr -dr com.apple.quarantine "$app" 2>/dev/null
finish true ""
start_app
rm -rf "$old" "$container"
`;

/**
 * The command that swaps in the staged app, as { command, args, env, verbatim }: `env` goes into
 * its environment, and `verbatim` is spawn's windowsVerbatimArguments.
 * @param {{ platform?: string, pid: number, appPath: string, staged: string, container: string,
 *   old: string, version: string, result: string, relaunch: boolean, script?: string, tries?: number }} options
 *   `script`: on macOS, the file the shell script was written to (swapScript). `tries`: on
 *   Windows, how many times each folder is renamed before giving up, half a second apart.
 * @returns {{ command: string, args: string[], env: Record<string, string>, verbatim: boolean }}
 */
function swapCommand({ platform = process.platform, pid, appPath, staged, container, old, version, result, relaunch, script, tries = 60 }) {
  if (platform === 'win32') {
    // Windows PowerShell started without a console (spawn's `detached`) exits at once and runs
    // nothing, and one started with the app's console is in the app's job, which ends it when the
    // app quits. cmd's `start` gives it a console of its own. The script goes in as
    // -EncodedCommand: a policy that allows only signed script files does not apply to a command.
    // cmd takes at most 8191 characters and the script takes most of them, so the values go in
    // the environment. The arguments then need no quoting, and cmd does not read Node's quotes.
    return {
      command: 'cmd.exe',
      args: ['/d', '/c', 'start', '""', '/min', 'powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', POWERSHELL_ENCODED],
      env: { WORKTABS_SWAP: JSON.stringify({ pid: Number(pid), appPath, staged, container, old, version, result, relaunch, tries }) },
      verbatim: true,
    };
  }
  return { command: '/bin/sh', args: [script || '', String(pid), appPath, staged, container, old, version, result, relaunch ? '1' : '0'], env: {}, verbatim: false };
}

// The shell script for macOS, written to a file for /bin/sh.
function swapScript() {
  return SH;
}

// What the swap wrote, as { version, ok, error }, or null when it wrote nothing readable.
function readSwapResult(text) {
  try {
    const result = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    return result && typeof result.version === 'string' && typeof result.ok === 'boolean'
      ? { version: result.version, ok: result.ok, error: typeof result.error === 'string' ? result.error : '' } : null;
  } catch { return null; }
}

module.exports = { readSwapResult, swapCommand, swapScript };
