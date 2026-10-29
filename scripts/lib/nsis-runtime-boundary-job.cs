using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Trusted fixture infrastructure only. Product code is held behind stdin until
// assignment succeeds. Closing the job also kills descendants after parent exit.
public sealed class HpmRuntimeBoundaryJob : IDisposable
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(SafeFileHandle job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out Accounting information, uint length, IntPtr returnedLength);
    private SafeFileHandle handle;
    public HpmRuntimeBoundaryJob() {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle.IsInvalid) { handle.Dispose(); throw new InvalidOperationException("runtime_job_failed"); }
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>())) {
            handle.Dispose();
            throw new InvalidOperationException("runtime_job_failed");
        }
    }
    public void Assign(Process process) {
        if (handle.IsClosed || !AssignProcessToJobObject(handle, process.Handle))
            throw new InvalidOperationException("runtime_job_failed");
    }
    public void StopAndWait(int milliseconds) {
        if (milliseconds < 1 || milliseconds > 5000 || handle.IsClosed || !TerminateJobObject(handle, 1))
            throw new InvalidOperationException("runtime_job_failed");
        WaitForEmpty(milliseconds);
    }
    // Independent observation before any forced cleanup. A successful native
    // control receipt cannot by itself claim that all descendants exited.
    public void WaitForEmpty(int milliseconds) {
        if (milliseconds < 1 || milliseconds > 5000 || handle.IsClosed)
            throw new InvalidOperationException("runtime_job_failed");
        var deadline = Stopwatch.StartNew();
        do {
            Accounting information;
            if (!QueryInformationJobObject(handle, 1, out information, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero))
                throw new InvalidOperationException("runtime_job_failed");
            if (information.ActiveProcesses == 0) return;
            System.Threading.Thread.Sleep(10);
        } while (deadline.ElapsedMilliseconds < milliseconds);
        throw new InvalidOperationException("runtime_job_failed");
    }
    public void Dispose() { handle.Dispose(); }
}
