using System;
using System.Runtime.InteropServices;

namespace HpmIoSchemaTdh {
    public sealed class Failure : InvalidOperationException {
        public string phase { get; private set; }
        public uint? status { get; private set; }
        internal Failure(string phase, uint? status = null) : base("io_schema_tdh_failed") { this.phase=phase;this.status=status; }
        internal static Failure At(Exception error, string phase) {
            var known=error as Failure;if(known!=null)return known;
            var pin=error as TracePinFailure;return pin==null?new Failure(phase):new Failure(pin.phase,pin.status);
        }
        public static Failure Describe(Exception error, string fallback) {
            for(int i=0;error!=null && i<8;i++,error=error.InnerException) {
                var known=error as Failure;if(known!=null)return known;
                var pin=error as TracePinFailure;if(pin!=null)return new Failure(pin.phase,pin.status);
            }
            return new Failure(fallback == "abi" ? "abi" : fallback == "serialization" ? "serialization" : "metadata");
        }
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Descriptor {
        public ushort Id; public byte Version, Channel, Level, Opcode;
        public ushort Task; public ulong Keyword;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Header {
        public ushort Size, HeaderType, Flags, EventProperty;
        public uint ThreadId, ProcessId; public long Timestamp;
        public Guid Provider; public Descriptor Descriptor;
        public uint KernelTime, UserTime; public Guid Activity;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct TraceHeader {
        public ushort Size, FieldTypeFlags; public uint Version, ThreadId, ProcessId;
        public long Timestamp; public Guid Guid; public uint KernelTime, UserTime;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct TraceEvent {
        public TraceHeader Header; public uint InstanceId, ParentInstanceId;
        public Guid ParentGuid; public IntPtr MofData; public uint MofLength, ClientContext;
    }
    [StructLayout(LayoutKind.Explicit, Size=172)] internal struct TimeZone {
        [FieldOffset(0)] public int Bias;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct LogHeader {
        public uint BufferSize, Version, ProviderVersion, NumberOfProcessors;
        public long EndTime; public uint TimerResolution, MaximumFileSize, LogFileMode, BuffersWritten;
        public Guid LogInstanceGuid; public IntPtr LoggerName, LogFileName;
        public TimeZone TimeZone; public long BootTime, PerfFreq, StartTime;
        public uint ReservedFlags, BuffersLost;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Logfile {
        public IntPtr LogFileName, LoggerName; public long CurrentTime;
        public uint BuffersRead, ProcessTraceMode; public TraceEvent CurrentEvent;
        public LogHeader LogfileHeader; public IntPtr BufferCallback;
        public uint BufferSize, Filled, EventsLost; public IntPtr EventRecordCallback;
        public uint IsKernelTrace; public IntPtr Context;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct TraceInfo {
        public Guid Provider, EventGuid; public Descriptor Descriptor; public uint DecodingSource;
        public uint ProviderName, LevelName, ChannelName, KeywordsName, TaskName, OpcodeName;
        public uint EventMessage, ProviderMessage, BinaryXmlOrEventName, BinaryXmlSizeOrEventAttributes;
        public uint ActivityIdName, RelatedActivityIdName;
        public uint PropertyCount, TopLevelPropertyCount, Flags;
    }
    [StructLayout(LayoutKind.Explicit, Size=24)] internal struct PropertyInfo {
        [FieldOffset(0)] public uint Flags;
        [FieldOffset(4)] public uint NameOffset;
        [FieldOffset(8)] public ushort InType;
        [FieldOffset(10)] public ushort OutType;
        [FieldOffset(12)] public uint MapOrSchemaOffset;
        [FieldOffset(16)] public ushort Count;
        [FieldOffset(18)] public ushort Length;
        [FieldOffset(20)] public uint Tags;
    }
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] internal delegate void RecordCallback(IntPtr record);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] internal delegate uint BufferCallback(IntPtr logfile);
    internal interface IApi {
        ulong Open(ref Logfile logfile);
        uint Process(ulong handle);
        uint Close(ulong handle);
        uint Information(IntPtr record, IntPtr buffer, ref uint size);
    }
    internal sealed class NativeApi : IApi {
        [DllImport("advapi32.dll", EntryPoint="OpenTraceW", ExactSpelling=true, SetLastError=true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern ulong OpenTrace(ref Logfile logfile);
        [DllImport("advapi32.dll", EntryPoint="ProcessTrace", ExactSpelling=true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern uint ProcessTrace([In] ulong[] handles, uint count, IntPtr start, IntPtr end);
        [DllImport("advapi32.dll", EntryPoint="CloseTrace", ExactSpelling=true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern uint CloseTrace(ulong handle);
        [DllImport("tdh.dll", EntryPoint="TdhGetEventInformation", ExactSpelling=true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern uint GetInformation(IntPtr record, uint count, IntPtr context, IntPtr buffer, ref uint size);
        public ulong Open(ref Logfile logfile) {
            ulong handle=OpenTrace(ref logfile);
            if(handle==UInt64.MaxValue)throw new Failure("open",unchecked((uint)Marshal.GetLastPInvokeError()));
            return handle;
        }
        public uint Process(ulong handle) { return ProcessTrace(new [] {handle}, 1, IntPtr.Zero, IntPtr.Zero); }
        public uint Close(ulong handle) { return CloseTrace(handle); }
        public uint Information(IntPtr record, IntPtr buffer, ref uint size) { return GetInformation(record, 0, IntPtr.Zero, buffer, ref size); }
    }
    internal static class Abi {
        internal static void Validate() {
            if (IntPtr.Size != 8 || Marshal.SizeOf<Descriptor>() != 16 || Marshal.SizeOf<Header>() != 80 ||
                Marshal.SizeOf<TraceEvent>() != 88 || Marshal.SizeOf<LogHeader>() != 280 ||
                Marshal.SizeOf<Logfile>() != 448 || Marshal.SizeOf<TraceInfo>() != 112 ||
                Marshal.SizeOf<PropertyInfo>() != 24 ||
                Marshal.OffsetOf<Logfile>("BufferCallback").ToInt64() != 400 ||
                Marshal.OffsetOf<Logfile>("EventRecordCallback").ToInt64() != 424 ||
                Marshal.OffsetOf<Logfile>("Context").ToInt64() != 440)
                throw new Failure("abi");
        }
    }
}
