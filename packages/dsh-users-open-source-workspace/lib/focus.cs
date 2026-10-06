using System;
using System.Text;
using System.Runtime.InteropServices;

/// <summary>
/// Win32 helpers for "open a folder and make sure its window is actually visible".
/// DSH starts plugin subprocesses hidden, so an explorer window spawned that way is
/// created with visible = false; plain SetForegroundWindow from a background process
/// is refused by Windows, hence the AttachThreadInput trick.
/// </summary>
public class FolderFocus
{
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lparam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool attachFlag);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

    /// <summary>VK_MENU (ALT). A synthetic tap makes Windows treat the focus change as user-driven.</summary>
    public const byte VK_MENU = 0x12;

    /// <summary>KEYEVENTF_KEYUP.</summary>
    public const uint KEYEVENTF_KEYUP = 0x0002;

    /// <summary>HWND_TOPMOST: keep the window above non-topmost windows.</summary>
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    /// <summary>HWND_NOTOPMOST: return the window to the normal band.</summary>
    public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

    /// <summary>SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW.</summary>
    public const uint SWP_KEEP = 0x0001 | 0x0002 | 0x0040;
}
