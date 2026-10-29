using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace HpmIoSchemaTdh {
    public sealed class Field {
        public string name { get; internal set; }
        public ushort inType { get; internal set; }
        public ushort outType { get; internal set; }
    }
    public sealed class Layout {
        public string provider { get; internal set; }
        public ushort id { get; internal set; }
        public byte version { get; internal set; }
        public byte opcode { get; internal set; }
        public ushort headerFlags { get; internal set; }
        public string descriptorIdentity { get; internal set; }
        public string metadataProvider { get; internal set; }
        public string eventClass { get; internal set; }
        public uint? decodingSource { get; internal set; }
        public ushort? metadataId { get; internal set; }
        public byte? metadataVersion { get; internal set; }
        public byte? metadataOpcode { get; internal set; }
        public string unsupported { get; internal set; }
        public long count { get; internal set; }
        public Field[] fields { get; internal set; } = Array.Empty<Field>();
    }
    public sealed class Summary {
        public int schemaVersion { get { return 1; } }
        public string scope { get { return "sampled_native_event_metadata"; } }
        public bool sampledMetadataOnly { get { return true; } }
        public bool eventValuesDecoded { get { return false; } }
        public bool fieldTypesVerified { get { return false; } }
        public bool filterAttributionQualified { get { return false; } }
        public bool traceCompletenessVerified { get { return false; } }
        public int realModelRequests { get { return 0; } }
        public int events { get; internal set; }
        public int selectedEvents { get; internal set; }
        public int unsupportedLayouts { get; internal set; }
        public Layout[] layouts { get; internal set; }
    }
    internal static class Metadata {
        internal const int MaximumBytes = 65536;
        internal static Failure Failed(string phase="metadata") { return new Failure(phase); }
        internal static T Read<T>(byte[] bytes, int offset) where T : struct {
            int size = Marshal.SizeOf<T>();
            if (offset < 0 || offset > bytes.Length - size) throw Failed("metadata-bounds");
            var pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try { return Marshal.PtrToStructure<T>(IntPtr.Add(pin.AddrOfPinnedObject(), offset)); }
            finally { pin.Free(); }
        }
        internal static string Name(byte[] bytes, uint offset, int minimum) {
            if (offset < minimum || offset >= bytes.Length || (offset & 1) != 0) throw Failed("metadata-name-offset");
            int start = checked((int)offset), end = start;
            for (; end <= bytes.Length - 2 && end - start <= 128; end += 2)
                if (bytes[end] == 0 && bytes[end + 1] == 0) break;
            if (end > bytes.Length - 2 || end - start > 128) throw Failed("metadata-name-termination");
            string name;
            try { name=new UnicodeEncoding(false,false,true).GetString(bytes,start,end-start); }
            catch(DecoderFallbackException) { throw Failed("metadata-name-encoding"); }
            if (!Regex.IsMatch(name, "\\A[A-Za-z_][A-Za-z0-9_]{0,63}\\z")) return null;
            return name;
        }
        internal static void Parse(Layout layout, byte[] bytes) {
            if (bytes == null || bytes.Length > MaximumBytes) throw Failed("metadata-buffer");
            var info = Read<TraceInfo>(bytes, 0);
            int start = Marshal.SizeOf<TraceInfo>(), stride = Marshal.SizeOf<PropertyInfo>();
            if (info.PropertyCount > 64 || info.TopLevelPropertyCount > info.PropertyCount ||
                (ulong)start + (ulong)info.PropertyCount * (ulong)stride > (ulong)bytes.Length) throw Failed("metadata-array");
            if (info.DecodingSource > 3) { layout.unsupported = "unknown_decoding_source"; return; }
            layout.metadataProvider = info.Provider.ToString();
            layout.eventClass = info.EventGuid.ToString();
            layout.decodingSource = info.DecodingSource;
            layout.metadataId = info.Descriptor.Id;
            layout.metadataVersion = info.Descriptor.Version;
            layout.metadataOpcode = info.Descriptor.Opcode;
            if (info.PropertyCount == 0) { layout.unsupported = "empty_metadata"; return; }
            if (info.DecodingSource == 2) { layout.unsupported = "wpp_context_required"; return; }
            if (info.PropertyCount != info.TopLevelPropertyCount) { layout.unsupported = "nested_struct"; return; }
            var fields = new List<Field>();
            var names = new HashSet<string>(StringComparer.Ordinal);
            int minimum = checked(start + checked((int)info.PropertyCount * stride));
            for (int i = 0; i < info.PropertyCount; i++) {
                var property = Read<PropertyInfo>(bytes, checked(start + i * stride));
                if (property.Flags != 0 && property.Flags != 0x40) {
                    layout.unsupported = (property.Flags & 1) != 0 ? "nested_struct" :
                        (property.Flags & 6) != 0 ? "dynamic_count_or_length" :
                        (property.Flags & 0x80) != 0 ? "custom_schema" :
                        (property.Flags & 8) != 0 ? "wbem_xml_fragment" : "unknown_property_flags";
                    return;
                }
                string name = Name(bytes, property.NameOffset, minimum);
                if(name==null){layout.unsupported="field_name_policy";return;}
                if (!names.Add(name)) throw Failed("metadata-name-duplicate");
                fields.Add(new Field { name = name, inType = property.InType, outType = property.OutType });
            }
            layout.fields = fields.ToArray();
        }
        internal static void Obtain(IApi api, IntPtr record, Layout layout) {
            uint size = 0;
            uint status;
            try { status = api.Information(record, IntPtr.Zero, ref size); }
            catch(Exception error) { throw Failure.At(error,"information-size"); }
            if (status == 1168 || status == 2) { layout.unsupported = "metadata_unavailable"; return; }
            if (status != 122 || size < Marshal.SizeOf<TraceInfo>() || size > MaximumBytes) {
                if (status == 122 && size > MaximumBytes) { layout.unsupported = "metadata_buffer_limit"; return; }
                throw new Failure("information-size",status);
            }
            IntPtr buffer = Marshal.AllocHGlobal(checked((int)size));
            try {
                uint actual = size;
                try { status=api.Information(record, buffer, ref actual); }
                catch(Exception error) { throw Failure.At(error,"information-read"); }
                if (status != 0 || actual > size || actual < Marshal.SizeOf<TraceInfo>()) throw new Failure("information-read",status);
                var bytes = new byte[checked((int)actual)];
                Marshal.Copy(buffer, bytes, 0, bytes.Length);
                Parse(layout, bytes);
            } finally { Marshal.FreeHGlobal(buffer); }
        }
    }
}
