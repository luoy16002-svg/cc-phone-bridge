// conpty: starts a program in a pseudo console, which has no window at all, for tests that need a real Claude Code
// window on this computer without one showing on the screen. Prints the program's pid, keeps its screen output in a
// file (or drops it), and returns when the program exits.
//
//   conpty.exe <folder> <log file or -> <command line>
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class ConPty
{
    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePseudoConsole(COORD size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr pc);
    [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr pc);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, IntPtr attrs, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);

    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    static readonly IntPtr PSEUDOCONSOLE = (IntPtr)0x00020016;

    static int Main(string[] args)
    {
        if (args.Length < 3) { Console.Error.WriteLine("usage: conpty <folder> <log|-> <command line>"); return 5; }
        SafeFileHandle inRead, inWrite, outRead, outWrite;
        if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0) || !CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0)) return 2;
        IntPtr pc;
        int hr = CreatePseudoConsole(new COORD { X = 160, Y = 48 }, inRead, outWrite, 0, out pc);
        if (hr != 0) { Console.Error.WriteLine("CreatePseudoConsole " + hr); return 2; }
        inRead.Dispose();
        outWrite.Dispose();
        // the screen output must be read, or the program stops when the pipe is full
        Stream log = args[1] == "-" ? null : new FileStream(args[1], FileMode.Create, FileAccess.Write, FileShare.ReadWrite);
        var drain = new Thread(() =>
        {
            var s = new FileStream(outRead, FileAccess.Read);
            var buf = new byte[16384];
            int n;
            try { while ((n = s.Read(buf, 0, buf.Length)) > 0) if (log != null) { log.Write(buf, 0, n); log.Flush(); } } catch { }
        });
        drain.IsBackground = true;
        drain.Start();
        var si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        // no handles of ours: without this a program started from one with redirected output inherits those pipes
        // instead of the pseudo console, and Claude Code then thinks it runs non-interactively
        si.StartupInfo.dwFlags = 0x00000100;            // STARTF_USESTDHANDLES, all three left empty
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        si.lpAttributeList = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, ref size)) return 3;
        if (!UpdateProcThreadAttribute(si.lpAttributeList, 0, PSEUDOCONSOLE, pc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) return 3;
        PROCESS_INFORMATION pi;
        if (!CreateProcessW(null, args[2], IntPtr.Zero, IntPtr.Zero, false, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, args[0], ref si, out pi))
        {
            Console.Error.WriteLine("CreateProcess " + Marshal.GetLastWin32Error());
            return 4;
        }
        Console.WriteLine(pi.dwProcessId);
        Console.Out.Flush();
        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        ClosePseudoConsole(pc);
        GC.KeepAlive(inWrite);
        return (int)code;
    }
}
