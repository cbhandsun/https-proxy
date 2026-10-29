using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using HpmIoSchemaTdh;

namespace HpmPersistentFilterIo {
    public static class RawReader {
        private const int MaximumOutput=8388608;
        internal static string Consume(IRawApi api,string trace,string[] allowedTags){
            Abi.Validate();if(Marshal.SizeOf<PropertyDescriptor>()!=16||
                Marshal.OffsetOf<PropertyDescriptor>("ArrayIndex").ToInt64()!=8||
                Marshal.OffsetOf<PropertyDescriptor>("Reserved").ToInt64()!=12)throw new Failure("raw-abi");
            var selection=new RawSelection(allowedTags);var output=new StringBuilder();
            var schemas=new Dictionary<string,RawProperties>(StringComparer.Ordinal);
            var timer=Stopwatch.StartNew();int events=0;Failure failure=null;
            Action<object> emit=(row)=>{
                // Every value is an ASCII scalar or fixed label; no original path is serialized.
                string line=JsonSerializer.Serialize(row)+"\n";
                if(line.Length>MaximumOutput-output.Length)throw new Failure("raw-output-limit");
                output.Append(line);
            };
            RecordCallback callback=(record)=>{
                if(failure!=null)return;
                try{
                    if(record==IntPtr.Zero)throw new Failure("callback-record-null");
                    if(++events>1000000)throw new Failure("callback-event-limit");
                    if(timer.ElapsedMilliseconds>=30000)throw new Failure("callback-deadline");
                    var header=Marshal.PtrToStructure<Header>(record);byte op=header.Descriptor.Opcode,version=header.Descriptor.Version;
                    if(header.Provider!=new Guid("90cbdc39-4a3e-11d1-84f4-0000f80464e3"))return;
                    if(!(op==0||op==32||op==35||op==36||op==64||op==66||op==73||op==76||RawSelection.IsNonFlush(op)||(op>=96&&op<=101)))return;
                    if(header.Timestamp<0||(header.Flags&0x40)==0||(header.Flags&0x20)!=0)throw new Failure("raw-header");
                    if(op>=96?version!=3:(op==0||op==32||op==35||op==36)?version>3:(version!=2&&version!=3))throw new Failure("raw-version");
                    string key=Reader.Key(header);
                    if(!schemas.TryGetValue(key,out RawProperties properties)){
                        if(schemas.Count>=64)throw new Failure("raw-schema-limit");
                        properties=RawProperties.Describe(api,record,header);schemas.Add(key,properties);
                    }
                    var row=selection.Select(header,record,api,properties,emit);if(row!=null)emit(row);
                }catch(Exception error){failure=Failure.At(error,"raw-callback");}
            };
            BufferCallback buffer=(_)=>{
                try{if(timer.ElapsedMilliseconds>=30000&&failure==null)failure=new Failure("callback-deadline");return failure==null?1u:0u;}
                catch(Exception error){failure=Failure.At(error,"raw-callback");return 0u;}
            };
            IntPtr filename=Marshal.StringToHGlobalUni(trace);ulong handle=UInt64.MaxValue;
            try{
                var logfile=new Logfile{LogFileName=filename,ProcessTraceMode=0x10001000,
                    EventRecordCallback=Marshal.GetFunctionPointerForDelegate(callback),BufferCallback=Marshal.GetFunctionPointerForDelegate(buffer)};
                handle=api.Open(ref logfile);if(handle==UInt64.MaxValue)throw new Failure("open");
                if(logfile.LogfileHeader.ReservedFlags!=1||logfile.LogfileHeader.PerfFreq<=0)throw new Failure("raw-clock");
                emit(new {type="clock",kind="qpc",frequency=logfile.LogfileHeader.PerfFreq.ToString(CultureInfo.InvariantCulture)});
                uint status=api.Process(handle);
                if(failure!=null)throw failure;if(status!=0)throw new Failure("process",status);
                if(events==0)throw new Failure("raw-empty");
            }catch(Exception error){failure=Failure.At(error,"raw-reader");throw failure;}
            finally{
                try{if(handle!=UInt64.MaxValue){try{uint status=api.Close(handle);if(status!=0&&failure==null)throw new Failure("close",status);}
                    catch(Exception error){if(failure==null)throw Failure.At(error,"close");}}}
                finally{Marshal.FreeHGlobal(filename);GC.KeepAlive(callback);GC.KeepAlive(buffer);}
            }
            return output.ToString();
        }
        public static string Read(string trace,string[] allowedFixtureTags){
            using(var pins=TracePins.OpenOwned(trace)){
                string result=Consume(new RawApi(),trace,allowedFixtureTags);pins.Verify();return result;
            }
        }
    }
}
