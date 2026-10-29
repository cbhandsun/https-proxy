using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using HpmIoSchemaTdh;

public static class HpmTdhManagedTests {
    private static void Check(bool condition) { if (!condition) throw new Exception("tdh_managed_assertion_failed"); }
    private static void Reject(Action action) {
        try { action(); } catch (InvalidOperationException error) {
            Check(error.Message == "io_schema_tdh_failed"); return;
        }
        throw new Exception("tdh_missing_refusal");
    }
    private static Header Event(ushort id = 1, byte opcode = 96) {
        return new Header { Size = 80, Provider = new Guid("90cbdc39-4a3e-11d1-84f4-0000f80464e3"),
            Descriptor = new Descriptor { Id = id, Version = 3, Opcode = opcode } };
    }
    private static void Store<T>(byte[] bytes, int offset, T value) where T : struct {
        var pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try { Marshal.StructureToPtr(value, IntPtr.Add(pin.AddrOfPinnedObject(), offset), false); }
        finally { pin.Free(); }
    }
    private static byte[] Schema(int count = 1, uint flags = 0) {
        int header = Marshal.SizeOf<TraceInfo>(), stride = Marshal.SizeOf<PropertyInfo>();
        var bytes = new byte[header + Math.Max(count, 1) * stride + Math.Max(count, 1) * 16 + 64];
        Store(bytes, 0, new TraceInfo { Provider = Event().Provider, EventGuid = Guid.Empty,
            Descriptor = Event().Descriptor, DecodingSource = 1, PropertyCount = (uint)count, TopLevelPropertyCount = (uint)count });
        for (int i = 0; i < count; i++) {
            int offset = header + count * stride + i * 16;
            Store(bytes, header + i * stride, new PropertyInfo { NameOffset = (uint)offset, InType = 16, OutType = 0, Flags = flags });
            var name = Encoding.Unicode.GetBytes("Field" + i + "\0");
            Array.Copy(name, 0, bytes, offset, name.Length);
        }
        // Unused provider-message bytes must never be interpreted or exported.
        Array.Copy(Encoding.Unicode.GetBytes("PRIVATE_METADATA_MESSAGE"), 0, bytes, bytes.Length - 48, 48);
        return bytes;
    }
    private sealed class Fake : IApi {
        internal readonly List<Header> Headers = new List<Header> { Event(), Event() };
        internal byte[] Bytes = Schema();
        internal string Mode = "normal";
        internal int Closed, Queried, Filled;
        internal bool Processing;
        private RecordCallback callback;
        private BufferCallback buffer;
        public ulong Open(ref Logfile logfile) {
            Check(logfile.ProcessTraceMode == 0x10000000 && logfile.LoggerName == IntPtr.Zero);
            callback = Marshal.GetDelegateForFunctionPointer<RecordCallback>(logfile.EventRecordCallback);
            buffer = Marshal.GetDelegateForFunctionPointer<BufferCallback>(logfile.BufferCallback);
            return Mode == "open" ? UInt64.MaxValue : 7;
        }
        public uint Process(ulong handle) {
            Check(handle == 7); Processing = true;
            try {
                if (Mode == "process") throw new Exception("PRIVATE_PROCESS");
                if (Mode == "null") { callback(IntPtr.Zero); Check(buffer(IntPtr.Zero) == 0); return 1223; }
                IntPtr record = Marshal.AllocHGlobal(112);
                try {
                    foreach (var header in Headers) {
                        Marshal.StructureToPtr(header, record, false);
                        Marshal.WriteIntPtr(record, 96, new IntPtr(1));
                        Marshal.WriteIntPtr(record, 88, new IntPtr(1));
                        callback(record);
                        if (buffer(IntPtr.Zero) == 0) return 1223;
                    }
                } finally { Marshal.FreeHGlobal(record); }
                return Mode == "cancel" ? 1223u : 0u;
            } finally { Processing = false; }
        }
        public uint Close(ulong handle) { Check(!Processing && handle == 7); Closed++; return Mode == "close" ? 6u : 0u; }
        public uint Information(IntPtr record, IntPtr target, ref uint size) {
            if (Mode == "callback") throw new Exception("PRIVATE_NATIVE_CALLBACK");
            if (target == IntPtr.Zero) {
                Queried++;
                size = Mode == "huge" ? 65537u : (uint)Bytes.Length;
                return Mode == "missing" ? 1168u : Mode == "parameter" ? 87u : 122u;
            }
            Filled++;
            if (Mode == "grow") { size++; return 122; }
            if (Mode == "short") { size = 1; return 0; }
            Marshal.Copy(Bytes, 0, target, Bytes.Length); size = (uint)Bytes.Length; return 0;
        }
    }
    public static object Run() {
        Abi.Validate();
        int checks = 0;
        var identity = new TracePins.Info {Volume=1,IndexHigh=2,IndexLow=3,SizeLow=4096,
            Created=new TracePins.Time {Low=4,High=5},Written=new TracePins.Time {Low=6,High=7}};
        Check(TracePins.Matches(identity,identity,true)); checks++;
        foreach (string field in new [] {"Volume","IndexHigh","IndexLow","CreatedLow","CreatedHigh","WrittenLow","WrittenHigh","SizeLow","SizeHigh"}) {
            var changed=identity;
            switch(field) {
                case "Volume":changed.Volume++;break;
                case "IndexHigh":changed.IndexHigh++;break;
                case "IndexLow":changed.IndexLow++;break;
                case "CreatedLow":changed.Created.Low++;break;
                case "CreatedHigh":changed.Created.High++;break;
                case "WrittenLow":changed.Written.Low++;break;
                case "WrittenHigh":changed.Written.High++;break;
                case "SizeLow":changed.SizeLow++;break;
                case "SizeHigh":changed.SizeHigh++;break;
            }
            Check(!TracePins.Matches(identity,changed,true)); checks++;
            if(field.StartsWith("Volume") || field.StartsWith("Index") || field.StartsWith("Created")) {
                Check(!TracePins.Matches(identity,changed,false)); checks++;
            }
        }
        // Ordinary directory mtime/size changes must not invent an identity change.
        var directoryChanged=identity;directoryChanged.SizeLow++;directoryChanged.Written.Low++;
        Check(TracePins.Matches(identity,directoryChanged,false)); checks++;

        var normal = new Fake();
        var result = Reader.Consume(normal, "not-a-real-etl");
        Check(result.events == 2 && result.selectedEvents == 2 && result.layouts.Length == 1 && result.layouts[0].count == 2);
        Check(normal.Queried == 1 && normal.Filled == 1 && normal.Closed == 1);
        Check(result.layouts[0].fields[0].name == "Field0" && result.layouts[0].fields[0].inType == 16); checks++;
        var nonTarget = new Fake(); nonTarget.Headers.Add(Event(2, 1));
        Check(Reader.Consume(nonTarget, "none").events == 3 && nonTarget.Queried == 1); checks++;
        foreach (string mode in new [] { "open", "process", "close", "cancel", "callback", "null", "parameter", "grow", "short" }) {
            var api = new Fake { Mode = mode }; Reject(() => Reader.Consume(api, "none"));
            Check(api.Closed == (mode == "open" ? 0 : 1)); checks++;
        }
        var cases = new [] {
            new {Mode="open",Phase="open",Status=(uint?)null},
            new {Mode="process",Phase="process",Status=(uint?)null},
            new {Mode="close",Phase="close",Status=(uint?)6},
            new {Mode="cancel",Phase="process",Status=(uint?)1223},
            new {Mode="callback",Phase="information-size",Status=(uint?)null},
            new {Mode="null",Phase="callback-record-null",Status=(uint?)null},
            new {Mode="parameter",Phase="information-size",Status=(uint?)87},
            new {Mode="grow",Phase="information-read",Status=(uint?)122},
            new {Mode="short",Phase="information-read",Status=(uint?)0}
        };
        foreach(var item in cases) {
            var api=new Fake {Mode=item.Mode};
            try { Reader.Consume(api,"none");throw new Exception("missing_failure"); }
            catch(Failure error) {
                Check(error.phase==item.Phase && error.status==item.Status && error.Message=="io_schema_tdh_failed");
                Check(api.Closed==(item.Mode=="open"?0:1));checks++;
            }
        }
        var malformed=new Fake {Bytes=new byte[112]};
        Store(malformed.Bytes,0,new TraceInfo {PropertyCount=UInt32.MaxValue});
        try { Reader.Consume(malformed,"none");throw new Exception("missing_failure"); }
        catch(Failure error) { Check(error.phase=="metadata-array" && error.status==null && malformed.Closed==1);checks++; }
        Check(Failure.Describe(new Exception("PRIVATE",new Failure("abi")),"metadata").phase=="abi");checks++;
        foreach (string mode in new [] { "missing", "huge" }) {
            var api = new Fake { Mode = mode }; var summary = Reader.Consume(api, "none");
            Check(summary.unsupportedLayouts == 1 && summary.layouts[0].fields.Length == 0 && api.Filled == 0); checks++;
        }
        var empty = new Fake(); empty.Headers.Clear(); Reject(() => Reader.Consume(empty, "none")); Check(empty.Closed == 1); checks++;
        var noSelected = new Fake(); noSelected.Headers.Clear(); noSelected.Headers.Add(Event(1, 5)); Reject(() => Reader.Consume(noSelected, "none")); checks++;
        foreach (uint flag in new uint[] { 1, 2, 4, 8, 0x80, 0x100 }) {
            var layout = new Layout(); Metadata.Parse(layout, Schema(1, flag));
            Check(layout.unsupported != null && layout.fields.Length == 0); checks++;
        }
        Summary policySummary=null;
        foreach(string name in new [] {"field-with-hyphen","字段","", "123Field"}) {
            var bytes=Schema();var prop=Metadata.Read<PropertyInfo>(bytes,112);
            var nameBytes=Encoding.Unicode.GetBytes(name+"\0");Array.Copy(nameBytes,0,bytes,prop.NameOffset,nameBytes.Length);
            var layout=new Layout();Metadata.Parse(layout,bytes);
            Check(layout.unsupported=="field_name_policy" && layout.fields.Length==0);checks++;
            var api=new Fake {Bytes=bytes};var unsupported=Reader.Consume(api,"none");
            Check(unsupported.unsupportedLayouts==1 && api.Closed==1);policySummary=unsupported;checks++;
        }
        var invalidEncoding=Schema();var invalidProperty=Metadata.Read<PropertyInfo>(invalidEncoding,112);
        invalidEncoding[invalidProperty.NameOffset]=0;invalidEncoding[invalidProperty.NameOffset+1]=0xd8;
        invalidEncoding[invalidProperty.NameOffset+2]=0;invalidEncoding[invalidProperty.NameOffset+3]=0;
        try {Metadata.Parse(new Layout(),invalidEncoding);throw new Exception("missing_failure");}
        catch(Failure error){Check(error.phase=="metadata-name-encoding");checks++;}
        var tagged=new Layout();Metadata.Parse(tagged,Schema(1,0x40));Check(tagged.unsupported==null && tagged.fields.Length==1);checks++;
        foreach(uint flags in new uint[] {0x10,0x20,0x80000000}) {
            var layout=new Layout();Metadata.Parse(layout,Schema(1,flags));
            Check(layout.unsupported=="unknown_property_flags" && layout.fields.Length==0);checks++;
        }
        // Microsoft's RawDispatchClassic produces a full EVENT_RECORD whose
        // logged Size remains sizeof(EVENT_TRACE_HEADER), not sizeof(EVENT_HEADER).
        var classic=new Fake();var classicValue=Event();classicValue.Size=48;classicValue.Flags=0x100|0x40;
        classic.Headers[0]=classicValue;classic.Headers[1]=classicValue;
        var classicResult=Reader.Consume(classic,"none");
        Check(classicResult.events==2 && classicResult.layouts[0].headerFlags==(0x100|0x40) && classic.Closed==1);checks++;
        // Size is not used as an allocation bound; changing it cannot change
        // selection or parsing of the same fixed typed callback header.
        foreach(ushort recordedSize in new ushort[] {0,1,47,79,80,UInt16.MaxValue}) {
            var api=new Fake();var header=Event();header.Size=recordedSize;
            api.Headers[0]=header;api.Headers[1]=header;
            var summary=Reader.Consume(api,"none");
            Check(summary.events==2 && summary.selectedEvents==2 && api.Closed==1);checks++;
        }
        var validLogfile=new Logfile {ProcessTraceMode=0x10000000,LogFileName=new IntPtr(1),
            EventRecordCallback=new IntPtr(2),BufferCallback=new IntPtr(3)};
        Abi.ValidateLogfile(validLogfile);checks++;
        foreach(string field in new [] {"mode","callback","buffer","filename","logger"}) {
            var invalid=validLogfile;
            switch(field) {
                case "mode":invalid.ProcessTraceMode=0;break;
                case "callback":invalid.EventRecordCallback=IntPtr.Zero;break;
                case "buffer":invalid.BufferCallback=IntPtr.Zero;break;
                case "filename":invalid.LogFileName=IntPtr.Zero;break;
                case "logger":invalid.LoggerName=new IntPtr(4);break;
            }
            try {new NativeApi().Open(ref invalid);throw new Exception("native_mode_guard_missing");}
            catch(Failure error){Check(error.phase=="abi");checks++;}
        }
        Check(Failure.Describe(new Exception("PRIVATE",new TracePinFailure("path-open",5)),"metadata").phase=="path-open");checks++;
        Check(Failure.Describe(new Exception("PRIVATE",new TracePinFailure("path-open",5)),"metadata").status==5);checks++;
        Check(Failure.Describe(new Exception("PRIVATE"),"serialization").phase=="serialization");checks++;
        var zero = new Layout(); Metadata.Parse(zero, Schema(0)); Check(zero.unsupported == "empty_metadata"); checks++;
        var nested = Schema(); var info = Metadata.Read<TraceInfo>(nested, 0); info.TopLevelPropertyCount = 0; Store(nested, 0, info);
        var nestedLayout = new Layout(); Metadata.Parse(nestedLayout, nested); Check(nestedLayout.unsupported == "nested_struct"); checks++;
        foreach (uint source in new uint[] { 2, 4, UInt32.MaxValue }) {
            var bytes = Schema(); var h = Metadata.Read<TraceInfo>(bytes, 0); h.DecodingSource = source; Store(bytes, 0, h);
            var layout = new Layout(); Metadata.Parse(layout, bytes); Check(layout.unsupported != null); checks++;
        }
        foreach (uint offset in new uint[] { 0, 113, 65536, UInt32.MaxValue }) {
            var bytes = Schema(); var p = Metadata.Read<PropertyInfo>(bytes, 112); p.NameOffset = offset; Store(bytes, 112, p);
            Reject(() => Metadata.Parse(new Layout(), bytes)); checks++;
        }
        foreach (byte[] bytes in new [] { Array.Empty<byte>(), new byte[111], new byte[65537], Schema(65) }) {
            Reject(() => Metadata.Parse(new Layout(), bytes)); checks++;
        }
        var countOverflow = Schema(); var badInfo = Metadata.Read<TraceInfo>(countOverflow, 0); badInfo.PropertyCount = UInt32.MaxValue; Store(countOverflow, 0, badInfo);
        Reject(() => Metadata.Parse(new Layout(), countOverflow)); checks++;
        var duplicate = Schema(2); var a = Metadata.Read<PropertyInfo>(duplicate, 112); var b = Metadata.Read<PropertyInfo>(duplicate, 136); b.NameOffset = a.NameOffset; Store(duplicate, 136, b);
        Reject(() => Metadata.Parse(new Layout(), duplicate)); checks++;
        var noTerminator = Schema(); var property = Metadata.Read<PropertyInfo>(noTerminator, 112);
        for (int i = (int)property.NameOffset; i < noTerminator.Length; i++) noTerminator[i] = 65;
        Reject(() => Metadata.Parse(new Layout(), noTerminator)); checks++;
        var tooManyLayouts = new Fake(); tooManyLayouts.Headers.Clear();
        for (ushort i = 0; i < 65; i++) tooManyLayouts.Headers.Add(Event(i));
        Reject(() => Reader.Consume(tooManyLayouts, "none")); Check(tooManyLayouts.Closed == 1); checks++;
        var tooManyFields = new Fake { Bytes = Schema(64) }; tooManyFields.Headers.Clear();
        for (ushort i = 0; i < 5; i++) tooManyFields.Headers.Add(Event(i));
        Reject(() => Reader.Consume(tooManyFields, "none")); checks++;
        return new { checks = checks, summary = result, policySummary=policySummary, windowsNativeExecuted = false };
    }
}
