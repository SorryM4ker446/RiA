// A job owns the shell and ordinary descendant processes. Closing its last
// handle (including shell termination) kills the remaining members. This is
// process lifetime management, not a filesystem or network sandbox.
const jobSource = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RiATerminalJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr Minimum, Maximum; public uint ActiveProcesses;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Counters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public Basic Basic; public Counters IO;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  static IntPtr owner;
  public static void Attach(uint parentId) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    var limits = new Limits(); limits.Basic.Flags = 0x2000;
    int length = Marshal.SizeOf(typeof(Limits)); IntPtr data = Marshal.AllocHGlobal(length);
    try {
      Marshal.StructureToPtr(limits, data, false);
      if (!SetInformationJobObject(job, 9, data, (uint)length) || !AssignProcessToJobObject(job, GetCurrentProcess())) {
        int error = Marshal.GetLastWin32Error(); CloseHandle(job); throw new Win32Exception(error);
      }
      owner = job;
      IntPtr parent = OpenProcess(0x100000, false, parentId);
      if (parent == IntPtr.Zero) throw new Win32Exception();
      var watcher = new System.Threading.Thread(() => {
        uint result = WaitForSingleObject(parent, 0xffffffff);
        CloseHandle(parent);
        if (result == 0) Environment.Exit(125);
      });
      watcher.IsBackground = true; watcher.Start();
    } finally { Marshal.FreeHGlobal(data); }
  }
}
`;

export function encodedPowerShellCommand() {
  const source = Buffer.from(jobSource, "utf8").toString("base64");
  return Buffer.from(`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}')))
  [RiATerminalJob]::Attach(${process.pid})
  $command = [Console]::In.ReadToEnd()
  $global:LASTEXITCODE = 0
  & ([ScriptBlock]::Create($command))
  if (-not $?) { exit 1 }
  exit $global:LASTEXITCODE
} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }
`, "utf16le").toString("base64");
}
