using System;
using System.Runtime.InteropServices;
using HpmIoSchemaTdh;

namespace HpmPersistentFilterIo {
    [StructLayout(LayoutKind.Sequential)] internal struct PropertyDescriptor {
        internal ulong Name; internal uint ArrayIndex, Reserved;
    }
    internal interface IRawApi : IApi {
        uint PropertySize(IntPtr record, ref PropertyDescriptor descriptor, out uint size);
        uint Property(IntPtr record, ref PropertyDescriptor descriptor, uint size, IntPtr buffer);
    }
    internal sealed class RawApi : IRawApi {
        private readonly NativeApi api=new NativeApi();
        [DllImport("advapi32.dll",EntryPoint="OpenTraceW",ExactSpelling=true,SetLastError=true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern ulong OpenRaw(ref Logfile file);
        [DllImport("tdh.dll",EntryPoint="TdhGetPropertySize",ExactSpelling=true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern uint Size(IntPtr record,uint contexts,IntPtr context,uint count,ref PropertyDescriptor descriptor,out uint size);
        [DllImport("tdh.dll",EntryPoint="TdhGetProperty",ExactSpelling=true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern uint Get(IntPtr record,uint contexts,IntPtr context,uint count,ref PropertyDescriptor descriptor,uint size,IntPtr buffer);
        public ulong Open(ref Logfile file){
            Abi.Validate();
            if(file.ProcessTraceMode!=0x10001000||file.EventRecordCallback==IntPtr.Zero||
                file.BufferCallback==IntPtr.Zero||file.LogFileName==IntPtr.Zero||file.LoggerName!=IntPtr.Zero)
                throw new Failure("raw-abi");
            ulong handle=OpenRaw(ref file);
            if(handle==UInt64.MaxValue)throw new Failure("open",unchecked((uint)Marshal.GetLastPInvokeError()));
            return handle;
        }
        public uint Process(ulong handle){return api.Process(handle);}
        public uint Close(ulong handle){return api.Close(handle);}
        public uint Information(IntPtr record,IntPtr buffer,ref uint size){return api.Information(record,buffer,ref size);}
        public uint PropertySize(IntPtr record,ref PropertyDescriptor descriptor,out uint size){return Size(record,0,IntPtr.Zero,1,ref descriptor,out size);}
        public uint Property(IntPtr record,ref PropertyDescriptor descriptor,uint size,IntPtr buffer){return Get(record,0,IntPtr.Zero,1,ref descriptor,size,buffer);}
    }
}
