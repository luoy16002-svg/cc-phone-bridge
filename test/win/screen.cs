// screen: prints what the console of a test window shows, line by line, for tests that check what a Claude Code
// window in a pseudo console looks like (its box, a picker). Tests point it at their own test windows only.
//
//   screen.exe <pid>
using System;
using System.Runtime.InteropServices;
using System.Text;

static class Screen
{
    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct SMALL_RECT { public short Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct CSBI { public COORD dwSize, dwCursorPosition; public short wAttributes; public SMALL_RECT srWindow; public COORD dwMaximumWindowSize; }

    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern bool ReadConsoleOutputCharacterW(IntPtr h, StringBuilder text, uint length, COORD at, out uint read);

    static int Main(string[] args)
    {
        uint pid;
        if (args.Length < 1 || !uint.TryParse(args[0], out pid)) return 5;
        FreeConsole();
        if (!AttachConsole(pid)) return 2;
        IntPtr h = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        CSBI info;
        if (h == new IntPtr(-1) || !GetConsoleScreenBufferInfo(h, out info)) return 3;
        var lines = new StringBuilder();
        int width = info.srWindow.Right - info.srWindow.Left + 1;
        for (int y = info.srWindow.Top; y <= info.srWindow.Bottom; y++)
        {
            var sb = new StringBuilder(width);
            uint read;
            ReadConsoleOutputCharacterW(h, sb, (uint)width, new COORD { X = info.srWindow.Left, Y = (short)y }, out read);
            lines.Append(sb.ToString(0, (int)Math.Min(read, (uint)sb.Length)).TrimEnd()).Append('\n');
        }
        FreeConsole();
        var stdout = Console.OpenStandardOutput();
        var bytes = Encoding.UTF8.GetBytes(lines.ToString());
        stdout.Write(bytes, 0, bytes.Length);
        return 0;
    }
}
