# Opens a folder in Explorer and makes the window actually visible, then lets go.
#
# Why this exists: DSH starts plugin subprocesses hidden, so an explorer window spawned from
# here is created with visible = false - it exists (COM enumerates it) but the user cannot
# see it. Showing it once and handing it the foreground once is the whole job.
#
# Deliberately NOT done here: HWND_TOPMOST, and a loop of SetForegroundWindow calls. Those
# keep the window glued on top for seconds and fight the app the user was just using, which
# feels like being hijacked ("did I just get a virus?"). If the other window takes the focus
# back, the folder window simply stays in the taskbar like any normal window.
# A synthetic ALT tap was also tried and made things worse - do not add keybd_event back.
#
# ASCII only on purpose: PowerShell 5.1 reads script files as ANSI unless they carry a BOM.
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'focus.cs')

$leaf = Split-Path -Leaf $Path
$shell = New-Object -ComObject Shell.Application
$shell.Explore($Path)
Start-Sleep -Milliseconds 1200

$script:target = [IntPtr]::Zero
$callback = [FolderFocus+EnumProc] {
    param($hwnd, $lparam)
    $cls = New-Object System.Text.StringBuilder 256
    [void][FolderFocus]::GetClassName($hwnd, $cls, 256)
    if ($cls.ToString() -ne 'CabinetWClass') { return $true }
    $title = New-Object System.Text.StringBuilder 512
    [void][FolderFocus]::GetWindowText($hwnd, $title, 512)
    if ($title.ToString() -like "$leaf*") {
        $script:target = $hwnd
        return $false
    }
    return $true
}
[void][FolderFocus]::EnumWindows($callback, [IntPtr]::Zero)

if ($script:target -eq [IntPtr]::Zero) {
    Write-Output "no-window:$leaf"
    exit 0
}

# One shot: make it visible, bring it forward, give it the foreground. Then stop.
$foreground = [FolderFocus]::GetForegroundWindow()
$foregroundThread = [FolderFocus]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero)
$myThread = [FolderFocus]::GetCurrentThreadId()
[void][FolderFocus]::AttachThreadInput($myThread, $foregroundThread, $true)
[void][FolderFocus]::ShowWindow($script:target, 5)   # SW_SHOW
[void][FolderFocus]::ShowWindow($script:target, 9)   # SW_RESTORE
[void][FolderFocus]::BringWindowToTop($script:target)
$focused = [FolderFocus]::SetForegroundWindow($script:target)
[void][FolderFocus]::AttachThreadInput($myThread, $foregroundThread, $false)

Write-Output ("shown:{0}:{1}" -f $leaf, $focused)
