// typein: types into the console of a running program, as if on its keyboard. Duty Desk uses it to hand a phone's
// message to a Claude Code window that is open on this computer, so the window shows the turn as it happens.
//
//   typein.exe <pid>            read steps from stdin, one per line, and type them into <pid>'s console
//   typein.exe <pid> --probe    only check that the console can be reached
//
// Steps: "T <base64 utf-8>" types text (a line break becomes Ctrl+J, Claude Code's new line), "P <base64 utf-8>"
// pastes text the way a terminal does (bracketed paste), "K <key>" presses enter, esc, backspace, an arrow (up, down,
// left, right), end, or ctrl+<letter>,
// "W <ms>" waits. Exit codes: 0 typed, 2 could not attach, 3 no console input, 4 a write failed, 5 bad step.
// Built on first use with the C# compiler that comes with Windows (see lib/typein.mjs).
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class TypeIn
{
    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    struct KEY_EVENT_RECORD
    {
        [FieldOffset(0)] public int bKeyDown;
        [FieldOffset(4)] public ushort wRepeatCount;
        [FieldOffset(6)] public ushort wVirtualKeyCode;
        [FieldOffset(8)] public ushort wVirtualScanCode;
        [FieldOffset(10)] public char UnicodeChar;
        [FieldOffset(12)] public uint dwControlKeyState;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUT_RECORD
    {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
    }

    const ushort KEY_EVENT = 1;
    const uint LEFT_CTRL_PRESSED = 0x0008;
    const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
    const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3;

    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] records, uint count, out uint written);

    static INPUT_RECORD Key(bool down, ushort vk, char ch, uint state)
    {
        var r = new INPUT_RECORD();
        r.EventType = KEY_EVENT;
        r.KeyEvent.bKeyDown = down ? 1 : 0;
        r.KeyEvent.wRepeatCount = 1;
        r.KeyEvent.wVirtualKeyCode = vk;
        r.KeyEvent.UnicodeChar = ch;
        r.KeyEvent.dwControlKeyState = state;
        return r;
    }

    static void Press(List<INPUT_RECORD> o, ushort vk, char ch, uint state)
    {
        o.Add(Key(true, vk, ch, state));
        o.Add(Key(false, vk, ch, state));
    }

    // Each character is one key carrying the character itself; a line break inside typed text is Ctrl+J.
    static void Text(List<INPUT_RECORD> o, string s)
    {
        foreach (char c in s.Replace("\r\n", "\n").Replace('\r', '\n'))
        {
            if (c == '\n') Press(o, 0x4A, '\n', LEFT_CTRL_PRESSED);
            else Press(o, 0, c, 0);
        }
    }

    static bool KeyStep(List<INPUT_RECORD> o, string name)
    {
        switch (name)
        {
            case "enter": Press(o, 0x0D, '\r', 0); return true;
            case "esc": Press(o, 0x1B, '\x1b', 0); return true;
            case "backspace": Press(o, 0x08, '\b', 0); return true;
            case "up": Press(o, 0x26, '\0', 0x0100); return true;
            case "down": Press(o, 0x28, '\0', 0x0100); return true;
            case "left": Press(o, 0x25, '\0', 0x0100); return true;
            case "right": Press(o, 0x27, '\0', 0x0100); return true;
            case "end": Press(o, 0x23, '\0', 0x0100); return true;
        }
        if (name.Length == 6 && name.StartsWith("ctrl+") && name[5] >= 'a' && name[5] <= 'z')
        {
            char letter = name[5];
            Press(o, (ushort)char.ToUpperInvariant(letter), (char)(letter - 'a' + 1), LEFT_CTRL_PRESSED);
            return true;
        }
        return false;
    }

    static int Write(IntPtr h, List<INPUT_RECORD> o)
    {
        const int chunk = 512;
        for (int i = 0; i < o.Count; i += chunk)
        {
            int n = Math.Min(chunk, o.Count - i);
            var part = o.GetRange(i, n).ToArray();
            uint written;
            if (!WriteConsoleInputW(h, part, (uint)n, out written) || written != n) return 4;
        }
        o.Clear();
        return 0;
    }

    static int Main(string[] args)
    {
        uint pid;
        if (args.Length < 1 || !uint.TryParse(args[0], out pid)) return 5;
        bool probe = args.Length > 1 && args[1] == "--probe";
        var steps = new List<string>();
        if (!probe)
        {
            string line;
            while ((line = Console.In.ReadLine()) != null) if (line.Trim().Length > 0) steps.Add(line.Trim());
        }
        FreeConsole();
        if (!AttachConsole(pid))
        {
            Console.Error.WriteLine("attach " + Marshal.GetLastWin32Error());
            return 2;
        }
        IntPtr h = CreateFileW("CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (h == new IntPtr(-1)) { FreeConsole(); return 3; }
        int code = 0;
        try
        {
            var o = new List<INPUT_RECORD>();
            foreach (string step in steps)
            {
                string kind = step.Substring(0, 1);
                string arg = step.Length > 2 ? step.Substring(2) : "";
                if (kind == "T") Text(o, Encoding.UTF8.GetString(Convert.FromBase64String(arg)));
                else if (kind == "P")
                {
                    foreach (char c in "\x1b[200~") Press(o, 0, c, 0);
                    foreach (char c in Encoding.UTF8.GetString(Convert.FromBase64String(arg))) Press(o, 0, c, 0);
                    foreach (char c in "\x1b[201~") Press(o, 0, c, 0);
                }
                else if (kind == "K") { if (!KeyStep(o, arg)) { code = 5; break; } }
                else if (kind == "W")
                {
                    code = Write(h, o);
                    if (code != 0) break;
                    Thread.Sleep(Math.Max(0, Math.Min(5000, int.Parse(arg))));
                    continue;
                }
                else { code = 5; break; }
                code = Write(h, o);
                if (code != 0) break;
            }
        }
        finally
        {
            CloseHandle(h);
            FreeConsole();
        }
        return code;
    }
}
