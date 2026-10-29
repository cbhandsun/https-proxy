using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using HpmIoSchemaTdh;
using HpmPersistentFilterIo;

public static class FilterIoNativeTests {
    private static void Check(bool value){if(!value)throw new Exception("raw_managed_assertion_failed");}
    private const string FixturePath=@"C:\PRIVATE\hpm-wbipc-core-abc123\context\checkpoint.sqlite";
    private static string Tag(){return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("hpm-wbipc-core-abc123/context"))).ToLowerInvariant();}
    private sealed class Item {
        internal Header Header;internal Dictionary<string,object> Values;
        internal Item(byte opcode,long time,params object[] pairs){
            Header=new Header{Size=48,Flags=(ushort)(opcode==98||opcode==99?0x350:0x340),ProcessId=42,ThreadId=43,Timestamp=time,
                Provider=new Guid("90cbdc39-4a3e-11d1-84f4-0000f80464e3"),Descriptor=new Descriptor{Version=(byte)(opcode==32||opcode==35?2:3),Opcode=opcode}};
            Values=new Dictionary<string,object>();for(int i=0;i<pairs.Length;i+=2)Values.Add((string)pairs[i],pairs[i+1]);
        }
    }
    private static Item Init(byte opcode=96,long time=20){
        var result=new Item(opcode,time,"RoutineAddr",3UL,"FileObject",1UL,"FileContext",4UL,"IrpPtr",2UL,"CallbackDataPtr",5UL,"MajorFunction",9u);
        if(opcode==98||opcode==99)result.Values.Add("InitialTime",20UL);
        if(opcode==100||opcode==101)result.Values.Add("Status",0xffffffffu);return result;
    }
    private static List<Item> Events(){return new List<Item>{
        new Item(32,0,"FileObject",100UL,"FileName",FixturePath),
        new Item(64,1,"FileObject",1UL,"IrpPtr",200UL,"OpenPath",FixturePath),
        new Item(73,10,"IrpPtr",2UL,"FileObject",1UL,"FileKey",100UL),Init(),Init(98,50),
        new Item(76,60,"IrpPtr",2UL,"NtStatus",0u),new Item(66,70,"IrpPtr",201UL,"FileObject",1UL,"FileKey",100UL)};}
    private static void Put<T>(byte[] data,int offset,T value) where T:struct{
        var pin=GCHandle.Alloc(data,GCHandleType.Pinned);try{Marshal.StructureToPtr(value,IntPtr.Add(pin.AddrOfPinnedObject(),offset),false);}finally{pin.Free();}
    }
    private sealed class Fake : IRawApi {
        internal List<Item> Items=Events();internal string Mode="normal";internal int Closed,Processes,PropertyCalls,Queries,Repeat;
        internal Item Current;private RecordCallback callback;private BufferCallback buffer;private bool processing;
        public ulong Open(ref Logfile file){
            Check(file.ProcessTraceMode==0x10001000&&file.LoggerName==IntPtr.Zero);
            callback=Marshal.GetDelegateForFunctionPointer<RecordCallback>(file.EventRecordCallback);
            buffer=Marshal.GetDelegateForFunctionPointer<BufferCallback>(file.BufferCallback);
            file.LogfileHeader.ReservedFlags=Mode=="clock"?2u:1u;file.LogfileHeader.PerfFreq=Mode=="frequency"?0:1000000;
            return Mode=="open"?UInt64.MaxValue:7;
        }
        public uint Process(ulong handle){
            Processes++;processing=true;
            try{
                if(Mode=="process")return 6;
                if(Mode=="null"){callback(IntPtr.Zero);Check(buffer(IntPtr.Zero)==0);return 1223;}
                IntPtr record=Marshal.AllocHGlobal(112);
                try{
                    if(Mode=="eventlimit"){
                        Current=Init();Current.Header.Provider=Guid.Empty;
                        for(int i=0;i<=1000000;i++)if(!Send(record,Current))return 1223;
                    }
                    foreach(var item in Items){Current=item;if(!Send(record,item))return 1223;}
                    for(int i=0;i<Repeat;i++){Current=Init();if(!Send(record,Current))return 1223;}
                }finally{Marshal.FreeHGlobal(record);}
                return Mode=="cancel"?1223u:0u;
            }finally{processing=false;}
        }
        private bool Send(IntPtr record,Item item){
            Marshal.StructureToPtr(item.Header,record,false);
            // TDH receives the record pointer, but our consumer never follows these.
            Marshal.WriteIntPtr(record,88,new IntPtr(1));Marshal.WriteIntPtr(record,96,new IntPtr(1));
            callback(record);return buffer(IntPtr.Zero)!=0;
        }
        public uint Close(ulong handle){Check(!processing&&handle==7);Closed++;return Mode=="close"?6u:0u;}
        private byte[] Schema(){
            int count=Current.Values.Count;var bytes=new byte[112+count*24+count*64];
            var info=new TraceInfo{Provider=new Guid("9e814aad-3204-11d2-9a82-006008a86939"),EventGuid=Current.Header.Provider,
                Descriptor=Current.Header.Descriptor,DecodingSource=1,PropertyCount=(uint)count,TopLevelPropertyCount=(uint)count};
            if(Mode=="schema-provider")info.Provider=Guid.Empty;
            if(Mode=="schema-version")info.Descriptor.Version++;
            if(Mode=="schema-nested")info.TopLevelPropertyCount=0;
            Put(bytes,0,info);int index=0;
            foreach(var item in Current.Values){
                ushort type=item.Value is string?(ushort)1:item.Value is uint?(ushort)8:item.Key=="InitialTime"?(ushort)10:(ushort)16;
                ushort output=item.Key=="InitialTime"?(ushort)27:item.Key=="Status"||item.Key=="NtStatus"?(ushort)18:(ushort)0;
                uint offset=(uint)(112+count*24+index*64);
                Put(bytes,112+24*index,new PropertyInfo{NameOffset=Mode=="schema-name"?0u:offset,
                    InType=Mode=="schema-type"?(ushort)255:type,OutType=output,Count=Mode=="schema-count"?(ushort)0:(ushort)1,
                    Flags=Mode=="schema-flags"?1u:0u});
                var text=Encoding.Unicode.GetBytes(item.Key+"\0");Array.Copy(text,0,bytes,offset,text.Length);index++;
            }
            return bytes;
        }
        public uint Information(IntPtr record,IntPtr target,ref uint size){
            var bytes=Schema();if(target==IntPtr.Zero){Queries++;size=Mode=="schema-huge"?65537u:(uint)bytes.Length;return Mode=="schema-missing"?1168u:122u;}
            if(Mode=="schema-read")return 6;Marshal.Copy(bytes,0,target,bytes.Length);size=(uint)bytes.Length;return 0;
        }
        private string Name(PropertyDescriptor descriptor){
            Check(descriptor.ArrayIndex==UInt32.MaxValue&&descriptor.Reserved==0);
            return Marshal.PtrToStringUni(new IntPtr(unchecked((long)descriptor.Name)));
        }
        private byte[] Value(PropertyDescriptor descriptor){
            object value=Current.Values[Name(descriptor)];
            return value is string?Encoding.Unicode.GetBytes((string)value+"\0"):value is uint?BitConverter.GetBytes((uint)value):BitConverter.GetBytes((ulong)value);
        }
        public uint PropertySize(IntPtr record,ref PropertyDescriptor descriptor,out uint size){
            if(Mode=="property-throw")throw new Exception("PRIVATE");
            size=(uint)Value(descriptor).Length;
            if(Mode=="property-zero")size=0;
            if(Mode=="property-short")size=1;
            if(Mode=="property-huge")size=UInt32.MaxValue;
            return Mode=="property-size"?87u:0u;
        }
        public uint Property(IntPtr record,ref PropertyDescriptor descriptor,uint size,IntPtr target){
            PropertyCalls++;if(Mode=="property-read")return 6;
            var value=Value(descriptor);Check(size==value.Length);
            if(Mode=="string-termination"&&Current.Values[Name(descriptor)] is string)value[value.Length-1]=1;
            if(Mode=="string-encoding"&&Current.Values[Name(descriptor)] is string){value[0]=0;value[1]=0xd8;}
            Marshal.Copy(value,0,target,value.Length);return 0;
        }
    }
    private static string Reject(Fake api,string expectedPhase=null,uint? expectedStatus=null){
        try{RawReader.Consume(api,"not-an-etl",new[]{Tag()});throw new Exception("missing_refusal");}
        catch(Failure error){Check(error.Message=="io_schema_tdh_failed");Check(api.Closed==(api.Mode=="open"?0:1));if(expectedPhase!=null)Check(error.phase==expectedPhase&&error.status==expectedStatus);return error.phase;}
    }
    public static string RawFixture(){return RawReader.Consume(new Fake(),"not-an-etl",new[]{Tag()});}
    public static object Run(){
        int checks=0;var normal=new Fake();string text=RawReader.Consume(normal,"not-an-etl",new[]{Tag()});
        var lines=text.Trim().Split('\n');Check(lines.Length==8&&normal.Closed==1);checks++;
        Check(!text.Contains("PRIVATE")&&!text.Contains("checkpoint")&&!text.Contains("C:"));checks++;
        using(var parsed=JsonDocument.Parse(lines[1]))Check(parsed.RootElement.GetProperty("fileKey").GetString()=="0x0000000000000064");checks++;
        using(var parsed=JsonDocument.Parse(lines[2])){Check(parsed.RootElement.GetProperty("fileObject").GetString()=="0x0000000000000001");Check(!parsed.RootElement.TryGetProperty("fileKey",out _));}checks++;
        using(var parsed=JsonDocument.Parse(lines[5]))Check(parsed.RootElement.GetProperty("initialTime").GetString()=="20");checks++;
        using(var parsed=JsonDocument.Parse(lines[6]))Check(parsed.RootElement.GetProperty("ntStatus").GetUInt32()==0);checks++;
        foreach(string mode in new[]{"open","clock","frequency","process","null","close","schema-huge","schema-missing","schema-read", "schema-provider","schema-version","schema-nested","schema-name","schema-type","schema-count","schema-flags", "property-size","property-read","property-zero","property-huge","property-throw","string-termination","string-encoding"}){
            Reject(new Fake{Mode=mode});checks++;
        }
        foreach(var expected in new[]{
            new{Mode="process",Phase="process",Status=(uint?)6},new{Mode="cancel",Phase="process",Status=(uint?)1223},
            new{Mode="property-size",Phase="raw-property-size",Status=(uint?)87},new{Mode="property-read",Phase="raw-property-read",Status=(uint?)6},
            new{Mode="property-throw",Phase="raw-callback",Status=(uint?)null},new{Mode="schema-missing",Phase="raw-schema-size",Status=(uint?)1168},
            new{Mode="schema-read",Phase="raw-schema-read",Status=(uint?)6},new{Mode="close",Phase="close",Status=(uint?)6}}){
            Reject(new Fake{Mode=expected.Mode},expected.Phase,expected.Status);checks++;
        }
        Reject(new Fake{Mode="property-short"},"raw-property-size");checks++;
        var missingStatus=new Fake();missingStatus.Items[5].Values.Remove("NtStatus");
        Check(Reject(missingStatus)=="raw-schema-fields");checks++;
        var clockFailure=new Fake{Mode="clock"};Reject(clockFailure,"raw-clock");Check(clockFailure.Processes==0);checks++;
        var replacement=new Fake();replacement.Items.Insert(2,new Item(64,2,"FileObject",1UL,"IrpPtr",999UL,"OpenPath",@"C:\PRIVATE\different.txt"));
        string replacementOutput=RawReader.Consume(replacement,"none",new[]{Tag()});
        Check(replacementOutput.Contains("\"type\":\"create\"")&&replacementOutput.Contains("\"fixtureTag\":null"));checks++;
        string unowned=RawReader.Consume(new Fake(),"none",new[]{new String('a',64)});
        Check(unowned.Trim().Split('\n').Length==1&&!unowned.Contains("0x"));checks++;
        Check(Reject(new Fake{Mode="eventlimit"})=="callback-event-limit");checks++;
        foreach(byte opcode in new byte[]{64,66,65,67,68,69,70,71,72,74,75,77}){
            var reused=new Fake();reused.Items.RemoveRange(5,2);
            reused.Items.Add(opcode==64?new Item(64,55,"FileObject",99UL,"IrpPtr",2UL,"OpenPath",@"C:\PRIVATE\other.txt"):
                opcode==66?new Item(66,55,"FileObject",99UL,"IrpPtr",2UL,"FileKey",999UL):new Item(opcode,55,"IrpPtr",2UL));
            reused.Items.Add(new Item(76,60,"IrpPtr",2UL,"NtStatus",0u));
            string reusedOutput=RawReader.Consume(reused,"none",new[]{Tag()});
            Check(reusedOutput.Contains("\"type\":\"invalidate-irp\""));
            Check(!reusedOutput.Contains("\"type\":\"end\""));checks++;
        }
        var unknownReuse=new Fake();unknownReuse.Items.RemoveRange(5,2);
        unknownReuse.Items.Add(new Item(67,55,"Other",2UL));
        unknownReuse.Items.Add(new Item(76,60,"IrpPtr",2UL,"NtStatus",0u));
        Check(Reject(unknownReuse)=="raw-schema-fields");checks++;
        var versionReuse=new Fake();versionReuse.Items.RemoveRange(5,2);
        var versionConflict=new Item(67,55,"IrpPtr",2UL);versionConflict.Header.Descriptor.Version=4;
        versionReuse.Items.Add(versionConflict);versionReuse.Items.Add(new Item(76,60,"IrpPtr",2UL,"NtStatus",0u));
        Check(Reject(versionReuse)=="raw-version");checks++;
        var unrelated=new Fake();unrelated.Items.Insert(5,new Item(67,55,"IrpPtr",999UL));
        string unrelatedOutput=RawReader.Consume(unrelated,"none",new[]{Tag()});
        Check(!unrelatedOutput.Contains("\"type\":\"invalidate-irp\"")&&unrelatedOutput.Contains("\"type\":\"end\""));checks++;
        var sameObject=new Fake();sameObject.Items.RemoveRange(5,2);
        sameObject.Items.Add(new Item(66,55,"FileObject",1UL,"IrpPtr",2UL,"FileKey",100UL));
        sameObject.Items.Add(new Item(76,60,"IrpPtr",2UL,"NtStatus",0u));
        string sameObjectOutput=RawReader.Consume(sameObject,"none",new[]{Tag()});
        Check(sameObjectOutput.IndexOf("\"type\":\"invalidate-irp\"",StringComparison.Ordinal)<sameObjectOutput.IndexOf("\"type\":\"close\"",StringComparison.Ordinal));checks++;
        using(var parsed=JsonDocument.Parse(lines[7]))Check(parsed.RootElement.GetProperty("irp").GetString()=="0x00000000000000c9");checks++;
        var manySchemas=new Fake();manySchemas.Items.Clear();
        for(ushort i=0;i<65;i++){var item=new Item(32,0,"FileObject",100UL,"FileName",FixturePath);item.Header.Descriptor.Task=i;manySchemas.Items.Add(item);}
        Check(Reject(manySchemas)=="raw-schema-limit");checks++;
        var manyNames=new Fake();manyNames.Items.Clear();
        for(ulong i=1;i<=257;i++)manyNames.Items.Add(new Item(32,0,"FileObject",i,"FileName",FixturePath));
        Check(Reject(manyNames)=="raw-state-limit");checks++;
        var manyIrps=new Fake();manyIrps.Items.RemoveRange(3,4);
        for(ulong i=10;i<=8202;i++)manyIrps.Items.Add(new Item(73,10,"IrpPtr",i,"FileObject",1UL,"FileKey",100UL));
        Check(Reject(manyIrps)=="raw-state-limit");checks++;
        var empty=new Fake();empty.Items.Clear();Check(Reject(empty)=="raw-empty");checks++;
        var outputLimit=new Fake{Repeat=40000};outputLimit.Items.RemoveAt(outputLimit.Items.Count-1);outputLimit.Items.RemoveAt(outputLimit.Items.Count-1);
        Check(Reject(outputLimit)=="raw-output-limit");checks++;
        var wrongVersion=new Fake();wrongVersion.Items[0].Header.Descriptor.Version=4;Check(Reject(wrongVersion)=="raw-version");checks++;
        var wrongWidth=new Fake();wrongWidth.Items[0].Header.Flags=0x320;Check(Reject(wrongWidth)=="raw-header");checks++;
        var negative=new Fake();negative.Items[0].Header.Timestamp=-1;Check(Reject(negative)=="raw-header");checks++;
        foreach(string[] tags in new[]{Array.Empty<string>(),new[]{Tag(),Tag()},new[]{"PRIVATE"},new string[257]}){
            try{RawReader.Consume(new Fake(),"none",tags);throw new Exception("missing_scope_refusal");}catch(Failure error){Check(error.phase=="raw-scope");checks++;}
        }
        var rawConfig=new Logfile{ProcessTraceMode=0x10000000};
        try{new RawApi().Open(ref rawConfig);throw new Exception("missing_mode_refusal");}catch(Failure error){Check(error.phase=="raw-abi");checks++;}
        var deleted=new Fake();deleted.Items.Insert(2,new Item(35,2,"FileObject",100UL,"FileName",FixturePath));
        Check(RawReader.Consume(deleted,"none",new[]{Tag()}).Contains("\"type\":\"name-delete\""));checks++;
        var changed=new Fake();changed.Items.Insert(2,new Item(32,2,"FileObject",100UL,"FileName",@"C:\PRIVATE\different.txt"));
        Check(RawReader.Consume(changed,"none",new[]{Tag()}).Contains("\"fixtureTag\":null"));checks++;
        return new{checks=checks,nativeWindowsExecuted=false,filterAttributionQualified=false,realModelRequests=0};
    }
}
