; Included by electron-builder (nsis.include) at the top of the installer and uninstaller scripts.

; Declares the installer DPI aware, so Windows does not draw it at 100% and stretch the bitmap
; at larger display scales. NSIS does not redraw its pages when the window moves to a
; monitor with another scale, so per-monitor awareness would not help.
ManifestDPIAware true

; Installs for the current user only, without the page that asks for whom. Worktabs updates
; itself by replacing the folder it runs from (src/self-update), which it cannot do in a folder
; that only administrators can write to, such as Program Files for an installation for all users.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
