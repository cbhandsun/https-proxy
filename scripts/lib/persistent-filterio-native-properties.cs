using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using HpmIoSchemaTdh;

namespace HpmPersistentFilterIo {
    internal sealed class RawProperties {
        internal readonly Dictionary<string,ushort> Types=new Dictionary<string,ushort>(StringComparer.Ordinal);
        private static Failure Error(string phase,uint? status=null){return new Failure(phase,status);}
        private static Dictionary<string,ushort> Required(Header header){
            byte op=header.Descriptor.Opcode;
            if(op>=96&&op<=101){
                var fields=new Dictionary<string,ushort>{{"RoutineAddr",16},{"FileObject",16},{"FileContext",16},
                    {"IrpPtr",16},{"CallbackDataPtr",16},{"MajorFunction",8}};
                if(op==98||op==99)fields.Add("InitialTime",10);
                if(op==100||op==101)fields.Add("Status",8);
                return fields;
            }
            if(op==0||op==32||op==35||op==36)return new Dictionary<string,ushort>{{"FileObject",16},{"FileName",1}};
            if(op==64)return new Dictionary<string,ushort>{{"FileObject",16},{"IrpPtr",16},{"OpenPath",1}};
            if(op==66||op==73)return new Dictionary<string,ushort>{{"IrpPtr",16},{"FileObject",16},{"FileKey",16}};
            if(RawSelection.IsNonFlush(op))return new Dictionary<string,ushort>{{"IrpPtr",16}};
            if(op==76)return new Dictionary<string,ushort>{{"IrpPtr",16},{"NtStatus",8}};
            throw Error("raw-schema");
        }
        internal static RawProperties Describe(IRawApi api,IntPtr record,Header header){
            uint size=0,status=api.Information(record,IntPtr.Zero,ref size);
            if(status!=122||size<112||size>65536)throw Error("raw-schema-size",status);
            IntPtr buffer=Marshal.AllocHGlobal((int)size);
            try{
                uint actual=size;status=api.Information(record,buffer,ref actual);
                if(status!=0||actual>size||actual<112)throw Error("raw-schema-read",status);
                var bytes=new byte[actual];Marshal.Copy(buffer,bytes,0,bytes.Length);
                var info=Metadata.Read<TraceInfo>(bytes,0);
                if(info.DecodingSource!=1||info.Provider!=new Guid("9e814aad-3204-11d2-9a82-006008a86939")||
                    info.EventGuid!=header.Provider)throw Error("raw-schema-provider");
                if(info.Descriptor.Id!=header.Descriptor.Id||info.Descriptor.Version!=header.Descriptor.Version||
                    info.Descriptor.Opcode!=header.Descriptor.Opcode)throw Error("raw-schema-descriptor");
                if(info.PropertyCount>64||info.PropertyCount!=info.TopLevelPropertyCount||
                    112UL+24UL*info.PropertyCount>actual)throw Error("raw-schema-layout");
                var required=Required(header);var result=new RawProperties();
                for(int i=0;i<info.PropertyCount;i++){
                    var property=Metadata.Read<PropertyInfo>(bytes,112+24*i);
                    if(property.Flags!=0&&property.Flags!=0x40)throw Error("raw-schema-flags");
                    string name=Metadata.Name(bytes,property.NameOffset,checked(112+24*(int)info.PropertyCount));
                    if(name==null||result.Types.ContainsKey(name))throw Error("raw-schema-fields");
                    result.Types.Add(name,property.InType);
                    if(!required.TryGetValue(name,out ushort type))continue;
                    if(property.InType!=type)throw Error("raw-schema-type");
                    if(property.Count!=1)throw Error("raw-schema-count");
                    uint width=type==1?0u:type==8?4u:8u;
                    if(property.Length!=0&&property.Length!=width)throw Error("raw-schema-length");
                    ushort output=property.OutType;
                    bool validOutput=type==1?(output==0||output==1):type==16?output==0:
                        name=="InitialTime"?output==27:(name=="Status"?output==18:
                        name=="NtStatus"?(output==0||output==18||output==31):output==0);
                    if(!validOutput)throw Error("raw-schema-output");
                }
                foreach(var item in required)if(!result.Types.ContainsKey(item.Key))throw Error("raw-schema-fields");
                if(header.Descriptor.Opcode>=96&&result.Types.Count!=required.Count)throw Error("raw-schema-fields");
                return result;
            }finally{Marshal.FreeHGlobal(buffer);}
        }
        internal object Read(IRawApi api,IntPtr record,string name){
            if(!Types.TryGetValue(name,out ushort type)||(type!=1&&type!=8&&type!=10&&type!=16))throw Error("raw-property-type");
            IntPtr text=Marshal.StringToHGlobalUni(name),buffer=IntPtr.Zero;
            try{
                var descriptor=new PropertyDescriptor{Name=unchecked((ulong)text.ToInt64()),ArrayIndex=UInt32.MaxValue};
                uint size,status=api.PropertySize(record,ref descriptor,out size);
                if(status!=0)throw Error("raw-property-size",status);
                if(type==1?(size<2||size>8194||(size&1)!=0):size!=(type==8?4u:8u))throw Error("raw-property-size");
                buffer=Marshal.AllocHGlobal((int)size);status=api.Property(record,ref descriptor,size,buffer);
                if(status!=0)throw Error("raw-property-read",status);
                if(type==8)return unchecked((uint)Marshal.ReadInt32(buffer));
                if(type==10||type==16)return unchecked((ulong)Marshal.ReadInt64(buffer));
                var bytes=new byte[size];Marshal.Copy(buffer,bytes,0,bytes.Length);
                if(bytes[bytes.Length-1]!=0||bytes[bytes.Length-2]!=0)throw Error("raw-property-string");
                string value;
                try{value=new UnicodeEncoding(false,false,true).GetString(bytes,0,bytes.Length-2);}
                catch(DecoderFallbackException){throw Error("raw-property-string");}
                if(value.IndexOfAny(new[]{'\0','\r','\n'})>=0)throw Error("raw-property-string");
                return value;
            }finally{if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);Marshal.FreeHGlobal(text);}
        }
    }
}
