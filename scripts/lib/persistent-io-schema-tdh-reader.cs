using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace HpmIoSchemaTdh {
    public static class Reader {
        internal static string Key(Header header) {
            var d = header.Descriptor;
            return String.Format(CultureInfo.InvariantCulture, "{0}:{1}:{2}:{3}:{4}:{5}:{6}:{7}:{8}",
                header.Provider, d.Id, d.Version, d.Channel, d.Level, d.Opcode, d.Task, d.Keyword, header.Flags);
        }
        internal static Summary Consume(IApi api, string trace) {
            Abi.Validate();
            var result = new Summary();
            var layouts = new Dictionary<string, Layout>(StringComparer.Ordinal);
            bool failed = false;
            Failure callbackFailure=null, primaryFailure=null;
            int fieldCells = 0;
            var clock = Stopwatch.StartNew();
            RecordCallback callback = (record) => {
                if (failed) return;
                try {
                    if (record == IntPtr.Zero) throw new Failure("callback-record-null");
                    if (++result.events > 1000000) throw new Failure("callback-event-limit");
                    if (clock.ElapsedMilliseconds >= 30000) throw new Failure("callback-deadline");
                    // Only the fixed native header is inspected. Payload and extended-data
                    // pointers are neither dereferenced, copied, hashed nor exported.
                    var header = Marshal.PtrToStructure<Header>(record);
                    // EVENT_RECORD_CALLBACK supplies the fixed EVENT_RECORD layout.
                    // Size describes the logged record, not the callback allocation:
                    // classic conversions can retain a 48-byte EVENT_TRACE_HEADER Size.
                    if (header.Provider != new Guid("90cbdc39-4a3e-11d1-84f4-0000f80464e3") ||
                        header.Descriptor.Opcode < 96 || header.Descriptor.Opcode > 101) return;
                    result.selectedEvents++;
                    string key = Key(header);
                    if (!layouts.TryGetValue(key, out Layout layout)) {
                        if (layouts.Count >= 64) throw new Failure("callback-layout-limit");
                        layout = new Layout { provider = header.Provider.ToString(), id = header.Descriptor.Id,
                            version = header.Descriptor.Version, opcode = header.Descriptor.Opcode, headerFlags = header.Flags,
                            descriptorIdentity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant() };
                        Metadata.Obtain(api, record, layout);
                        fieldCells += layout.fields.Length;
                        if (fieldCells > 256) throw new Failure("callback-field-limit");
                        if (layout.unsupported != null) result.unsupportedLayouts++;
                        layouts.Add(key, layout);
                    }
                    layout.count++;
                } catch(Exception error) { failed = true; callbackFailure=Failure.At(error,"callback"); }
            };
            BufferCallback buffer = (_) => {
                try { if (clock.ElapsedMilliseconds >= 30000) failed = true; return failed ? 0u : 1u; }
                catch(Exception error) { failed = true; callbackFailure=Failure.At(error,"callback"); return 0u; }
            };
            IntPtr filename = Marshal.StringToHGlobalUni(trace);
            ulong handle = UInt64.MaxValue;
            try {
                var logfile = new Logfile { LogFileName = filename, ProcessTraceMode = 0x10000000,
                    EventRecordCallback = Marshal.GetFunctionPointerForDelegate(callback),
                    BufferCallback = Marshal.GetFunctionPointerForDelegate(buffer) };
                try { handle=api.Open(ref logfile); } catch(Exception error) { throw Failure.At(error,"open"); }
                if (handle == UInt64.MaxValue) throw new Failure("open");
                uint status;
                try { status=api.Process(handle); } catch(Exception error) { throw Failure.At(error,"process"); }
                if(callbackFailure!=null)throw callbackFailure;
                if (status != 0) throw new Failure("process",status);
                if (failed || result.events == 0 || result.selectedEvents == 0) throw new Failure("callback");
                result.layouts = layouts.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => pair.Value).ToArray();
            } catch(Exception error) { primaryFailure=Failure.At(error,"process");throw primaryFailure; }
            finally {
                try {
                    if(handle!=UInt64.MaxValue) {
                        try { uint status=api.Close(handle);if(status!=0 && primaryFailure==null)throw new Failure("close",status); }
                        catch(Exception error) { if(primaryFailure==null)throw Failure.At(error,"close"); }
                    }
                }
                finally { Marshal.FreeHGlobal(filename); GC.KeepAlive(callback); GC.KeepAlive(buffer); }
            }
            return result;
        }
        public static Summary Read(string trace) {
            using (var pins = TracePins.OpenOwned(trace)) {
                var result = Consume(new NativeApi(), trace);
                pins.Verify();
                return result;
            }
        }
    }
}
