// Native helper for Worktabs. Three modes:
//
//   claude-wrap.exe <path-to-claude.exe> <args...>
//     Process wrapper for the Claude Code extension (claudeCode.claudeProcessWrapper).
//     Starts claude.exe with the same arguments, plus "--settings <file>" when
//     WORKTABS_CLAUDE_SETTINGS names a settings file, so the app's hooks apply only to the
//     sessions it manages. claude.exe inherits this process's stdin and stderr (the
//     extension's stream-json pipes); its stdout is copied through as it comes, and the
//     rate_limit_event lines in it also go to the app (see PumpOutput). It runs in a
//     kill-on-close job, so it dies with this process.
//     WORKTABS_PROC_ID (this process's id) goes to claude's environment, and from there
//     into every hook: one extension panel runs one claude, so the app can tell the
//     panels' conversations apart and see a panel's claude end.
//
//   claude-wrap.exe --hook
//     Command hook for events that cannot use http hooks (SessionStart). Posts stdin
//     unchanged to WORKTABS_HOOK_URL with the same headers the http hooks send. Prints
//     nothing and always exits 0, so it never blocks or decides anything.
//
//   claude-wrap.exe --explore <folder>
//   claude-wrap.exe --explore-select <file or folder>
//     Shows a folder (or an item selected in its folder) in File Explorer, as a new tab of
//     the frontmost Explorer window on the current desktop, or in a new window when there is
//     none. Windows has no API for Explorer tabs: the tab comes from the command Explorer's
//     own new-tab button sends (WM_COMMAND 0xA21B to its ShellTabWindowClass), and the new
//     tab is then driven through Shell.Application. If any of that fails, a new window opens.
//     The app starts this mode, so it may bring the window to the front.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class ClaudeWrap
{
    // Shell.Application needs a single-threaded apartment.
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--hook") return PostHook();
        if (args.Length == 2 && (args[0] == "--explore" || args[0] == "--explore-select")) return Explore(args[1], args[0] == "--explore-select");
        if (args.Length == 0)
        {
            Console.Error.WriteLine("usage: claude-wrap.exe <claude.exe> [args...] | --hook | --explore <folder> | --explore-select <path>");
            return 2;
        }

        var claudeArgs = new StringBuilder();
        for (int i = 1; i < args.Length; i++) AppendArg(claudeArgs, args[i]);
        string settings = Environment.GetEnvironmentVariable("WORKTABS_CLAUDE_SETTINGS");
        // A subcommand (the extension runs "auth status --json" to check the sign-in) rejects
        // --settings after it, and starts no session for the hooks anyway.
        bool session = args.Length < 2 || args[1].StartsWith("-", StringComparison.Ordinal);
        if (session && !string.IsNullOrEmpty(settings))
        {
            AppendArg(claudeArgs, "--settings");
            AppendArg(claudeArgs, settings);
        }

        IntPtr job = CreateKillOnCloseJob();
        var info = new ProcessStartInfo(args[0], claudeArgs.ToString()) { UseShellExecute = false, RedirectStandardOutput = true };
        string procId = Process.GetCurrentProcess().Id.ToString();
        info.EnvironmentVariables["WORKTABS_PROC_ID"] = procId;
        // Not disposed: the threads below may still use it as the wrapper exits.
        var usageLines = new BlockingCollection<byte[]>();
        using (Process child = Process.Start(info))
        {
            if (job != IntPtr.Zero) AssignProcessToJobObject(job, child.Handle);
            // One at a time, in order; the copy never waits for the app.
            var poster = new Thread(() =>
            {
                try
                {
                    foreach (byte[] body in usageLines.GetConsumingEnumerable()) Post("usage", body, procId);
                }
                catch (Exception)
                {
                    // Must not end the wrapper (see PumpOutput).
                }
            }) { IsBackground = true };
            var pump = new Thread(() => PumpOutput(child.StandardOutput.BaseStream, usageLines)) { IsBackground = true };
            poster.Start();
            pump.Start();
            child.WaitForExit();
            // The pipe may still hold claude's last output. A process claude started that keeps
            // the pipe open must not hold this one up (the job ends it when this one exits).
            pump.Join(5000);
            usageLines.CompleteAdding();
            poster.Join(3000);
            return child.ExitCode;
        }
    }

    // What a rate_limit_event line of claude's stream-json output has. Text inside a JSON string
    // cannot match it, as its quotes are escaped there. The app checks the type again.
    static readonly byte[] UsageType = Encoding.ASCII.GetBytes("\"type\":\"rate_limit_event\"");
    // Longer lines are not looked at; the event is small.
    const int MaxUsageLine = 64 * 1024;

    // Copies claude's stdout to this process's (the extension's pipe) as it comes, and hands each
    // rate_limit_event line to `usageLines` for the app: claude reports the subscription's usage
    // windows there, and never runs a status line command under the extension.
    static void PumpOutput(Stream input, BlockingCollection<byte[]> usageLines)
    {
        var buffer = new byte[64 * 1024];
        var line = new MemoryStream();
        bool keep = true;
        try
        {
            Stream output = Console.OpenStandardOutput();
            int count;
            while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                output.Write(buffer, 0, count);
                output.Flush();
                int start = 0;
                while (start < count)
                {
                    int newline = Array.IndexOf(buffer, (byte)'\n', start, count - start);
                    int end = newline < 0 ? count : newline;
                    if (keep)
                    {
                        line.Write(buffer, start, end - start);
                        keep = line.Length <= MaxUsageLine;
                        if (!keep) line.SetLength(0);
                    }
                    if (newline < 0) break;
                    if (keep && Contains(line, UsageType)) usageLines.TryAdd(line.ToArray());
                    line.SetLength(0);
                    keep = true;
                    start = newline + 1;
                }
            }
        }
        catch (Exception)
        {
            // The extension closed its end (or the wrapper is exiting). Closing this end makes
            // claude's writes fail, as they would without the wrapper. An exception must not get
            // out of this thread: it would end the wrapper, and claude with it.
        }
        finally
        {
            input.Dispose();
        }
    }

    static bool Contains(MemoryStream line, byte[] part)
    {
        byte[] bytes = line.GetBuffer();
        long last = line.Length - part.Length;
        for (long i = 0; i <= last; i++)
        {
            int j = 0;
            while (j < part.Length && bytes[i + j] == part[j]) j++;
            if (j == part.Length) return true;
        }
        return false;
    }

    static int PostHook()
    {
        try
        {
            // Read raw bytes: decoding stdin with the console code page would mangle UTF-8 JSON.
            byte[] body;
            using (Stream stdin = Console.OpenStandardInput())
            using (var buffer = new MemoryStream())
            {
                stdin.CopyTo(buffer);
                body = buffer.ToArray();
            }
            Post("hook", body, Environment.GetEnvironmentVariable("WORKTABS_PROC_ID"));
        }
        catch (Exception)
        {
            // The app being down must never fail or delay the session.
        }
        return 0;
    }

    // Posts to a route of the app's hook server (WORKTABS_HOOK_URL is its /hook), with the same
    // headers the http hooks send. Failures are ignored.
    static void Post(string route, byte[] body, string procId)
    {
        try
        {
            string url = Environment.GetEnvironmentVariable("WORKTABS_HOOK_URL");
            if (string.IsNullOrEmpty(url)) return;
            var request = (HttpWebRequest)WebRequest.Create(new Uri(new Uri(url), route));
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Timeout = 2000;
            request.Proxy = null;
            request.Headers.Add("X-Wrapper-Token", Environment.GetEnvironmentVariable("WORKTABS_HOOK_TOKEN") ?? "");
            request.Headers.Add("X-Wrapper-Tab", Environment.GetEnvironmentVariable("WORKTABS_TAB_ID") ?? "");
            request.Headers.Add("X-Wrapper-Proc", procId ?? "");
            request.ContentLength = body.Length;
            using (Stream stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
            using (request.GetResponse()) { }
        }
        catch (Exception)
        {
            // The app being down must never fail or delay the session.
        }
    }

    const uint WM_COMMAND = 0x0111;
    const int NEW_TAB_COMMAND = 0xA21B;
    const int SW_RESTORE = 9;
    // SVSI_SELECT | SVSI_DESELECTOTHERS | SVSI_ENSUREVISIBLE | SVSI_FOCUSED
    const int SELECT_ONLY = 1 | 4 | 8 | 16;

    static int Explore(string target, bool select)
    {
        target = Path.GetFullPath(target);
        string folder = select ? Path.GetDirectoryName(target) : target;
        try
        {
            IntPtr window = FrontExplorerWindow();
            if (folder != null && window != IntPtr.Zero && OpenInNewTab(window, folder, select ? Path.GetFileName(target) : null)) return 0;
        }
        catch (Exception)
        {
            // Falls back to a new window.
        }
        string arguments = select ? "/select," + Quote(target) : Quote(target);
        Process.Start(new ProcessStartInfo("explorer.exe", arguments) { UseShellExecute = false });
        return 0;
    }

    // The topmost visible Explorer window on the current virtual desktop, or zero.
    static IntPtr FrontExplorerWindow()
    {
        IVirtualDesktopManager desktops = null;
        try
        {
            desktops = (IVirtualDesktopManager)new VirtualDesktopManager();
        }
        catch (Exception)
        {
            // Without it, every window counts as on this desktop.
        }
        IntPtr found = IntPtr.Zero;
        // EnumWindows goes through top-level windows from the top of the Z order.
        EnumWindows((hwnd, _) =>
        {
            if (!IsWindowVisible(hwnd) || ClassName(hwnd) != "CabinetWClass") return true;
            bool here;
            if (desktops != null && desktops.IsWindowOnCurrentVirtualDesktop(hwnd, out here) == 0 && !here) return true;
            found = hwnd;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    // Opens a tab in the window, shows the folder in it (with `selectName` selected, if given)
    // and brings the window to the front. Returns false when no tab could be opened.
    static bool OpenInNewTab(IntPtr window, string folder, string selectName)
    {
        IntPtr tabHost = FindWindowEx(window, IntPtr.Zero, "ShellTabWindowClass", null);
        if (tabHost == IntPtr.Zero) return false;
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
        int before = TabsOf(shell, window).Count;
        SendMessage(tabHost, WM_COMMAND, (IntPtr)NEW_TAB_COMMAND, IntPtr.Zero);
        // The new tab shows Home (no file location) until it is navigated.
        dynamic tab = null;
        for (int i = 0; i < 30 && tab == null; i++)
        {
            List<object> tabs = TabsOf(shell, window);
            if (tabs.Count > before) tab = tabs.FindLast(t => !IsFileLocation(t)) ?? tabs[tabs.Count - 1];
            else Thread.Sleep(100);
        }
        if (tab == null) return false;
        tab.Navigate2(folder);
        if (selectName != null) SelectWhenShown(tab, folder, selectName);
        if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
        SetForegroundWindow(window);
        return true;
    }

    // The Shell.Application windows (one per tab) that belong to the Explorer window.
    static List<object> TabsOf(dynamic shell, IntPtr window)
    {
        var tabs = new List<object>();
        foreach (dynamic item in shell.Windows())
        {
            try
            {
                if (Convert.ToInt64(item.HWND) == window.ToInt64()) tabs.Add(item);
            }
            catch (Exception)
            {
                // A window that is closing.
            }
        }
        return tabs;
    }

    static bool IsFileLocation(dynamic tab)
    {
        try
        {
            string url = tab.LocationURL;
            return url != null && url.StartsWith("file:", StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception)
        {
            return false;
        }
    }

    // Selects an item of the folder once the tab has navigated there (up to 3 seconds).
    static void SelectWhenShown(dynamic tab, string folder, string name)
    {
        for (int i = 0; i < 30; i++)
        {
            try
            {
                dynamic view = tab.Document;
                string shown = view.Folder.Self.Path;
                if (string.Equals(shown.TrimEnd('\\'), folder.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                {
                    dynamic item = view.Folder.ParseName(name);
                    if (item != null) view.SelectItem(item, SELECT_ONLY);
                    return;
                }
            }
            catch (Exception)
            {
                // Still navigating.
            }
            Thread.Sleep(100);
        }
    }

    static string ClassName(IntPtr hwnd)
    {
        var name = new StringBuilder(256);
        GetClassName(hwnd, name, name.Capacity);
        return name.ToString();
    }

    static string Quote(string path)
    {
        return "\"" + path + "\"";
    }

    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);

    [DllImport("user32.dll")]
    static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hwnd, int command);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hwnd);

    [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IVirtualDesktopManager
    {
        [PreserveSig]
        int IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow, [MarshalAs(UnmanagedType.Bool)] out bool onCurrentDesktop);
    }

    [ComImport, Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")]
    class VirtualDesktopManager
    {
    }

    // Quotes one argument the way CommandLineToArgvW / the MSVC runtime parse it.
    static void AppendArg(StringBuilder sb, string arg)
    {
        if (sb.Length > 0) sb.Append(' ');
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
        {
            sb.Append(arg);
            return;
        }
        sb.Append('"');
        int backslashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"') sb.Append('\\', backslashes * 2 + 1);
            else sb.Append('\\', backslashes);
            backslashes = 0;
            sb.Append(c);
        }
        sb.Append('\\', backslashes * 2);
        sb.Append('"');
    }

    static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return job;
    }

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
}
