using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using HpmIoSchemaTdh;

namespace HpmPersistentFilterIo {
    internal sealed class RawSelection {
        private readonly HashSet<string> allowed;
        private readonly HashSet<ulong> names=new HashSet<ulong>(),files=new HashSet<ulong>();
        private readonly Dictionary<ulong,ulong> irps=new Dictionary<ulong,ulong>();
        internal RawSelection(string[] tags){
            if(tags==null||tags.Length==0||tags.Length>256)throw new Failure("raw-scope");
            allowed=new HashSet<string>(StringComparer.Ordinal);
            foreach(string tag in tags)if(tag==null||!Regex.IsMatch(tag,"\\A[a-f0-9]{64}\\z")||!allowed.Add(tag))throw new Failure("raw-scope");
        }
        internal static bool IsNonFlush(byte op){return op==65||op==67||op==68||op==69||op==70||op==71||op==72||op==74||op==75||op==77;}
        private static string Pointer(ulong value){return "0x"+value.ToString("x16",CultureInfo.InvariantCulture);}
        private Dictionary<string,object> PathClass(string path){
            if(path.Length>4096||path.IndexOfAny(new[]{'\0','\r','\n'})>=0)throw new Failure("raw-path");
            var match=Regex.Match(path,@"[\\/](hpm-wbipc-core-[a-z0-9]{6}[\\/]context|hpm-publication-interior-[a-z0-9]{6})[\\/]checkpoint\.sqlite(-journal)?\z",RegexOptions.IgnoreCase|RegexOptions.CultureInvariant);
            if(!match.Success)return new Dictionary<string,object>{{"fixtureTag",null},{"kind",null}};
            string tag=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(match.Groups[1].Value.Replace('\\','/').ToLowerInvariant()))).ToLowerInvariant();
            return allowed.Contains(tag)?new Dictionary<string,object>{{"fixtureTag",tag},{"kind",match.Groups[2].Success?"journal":"database"}}:
                new Dictionary<string,object>{{"fixtureTag",null},{"kind",null}};
        }
        private static ulong Address(RawProperties props,IRawApi api,IntPtr record,string name){return (ulong)props.Read(api,record,name);}
        private static void Bound(int count,int maximum){if(count>maximum)throw new Failure("raw-state-limit");}
        internal Dictionary<string,object> Select(Header header,IntPtr record,IRawApi api,RawProperties props,Action<object> emit){
            byte op=header.Descriptor.Opcode;string type;
            if(op==0||op==32||op==35||op==36)type=op==35?"name-delete":"name";
            else if(op==64)type="create";
            else if(op==66)type="close";
            else if(op==73)type="flush";
            else if(op==76)type="end";
            else if(IsNonFlush(op))type="invalidate-irp";
            else type=op<=97?"filter-init":op<=99?"filter-complete":"filter-failure";
            var row=new Dictionary<string,object>{{"type",type},{"time",header.Timestamp.ToString(CultureInfo.InvariantCulture)},
                {"pid",header.ProcessId},{"tid",header.ThreadId},{"version",header.Descriptor.Version},{"opcode",op}};
            if(type=="name"||type=="name-delete"){
                ulong key=Address(props,api,record,"FileObject");bool prior=names.Remove(key);
                row.Add("fileKey",Pointer(key));
                if(type=="name-delete")return prior?row:null;
                var classification=PathClass((string)props.Read(api,record,"FileName"));
                bool selected=classification["fixtureTag"]!=null;
                if(selected){names.Add(key);Bound(names.Count,256);}
                foreach(var item in classification)row.Add(item.Key,item.Value);
                return selected||prior?row:null;
            }
            if(type=="end"){
                ulong irp=Address(props,api,record,"IrpPtr");
                if(!irps.Remove(irp))return null;
                row.Add("irp",Pointer(irp));row.Add("ntStatus",(uint)props.Read(api,record,"NtStatus"));return row;
            }
            ulong irpValue=Address(props,api,record,"IrpPtr");
            if(type=="create"||type=="close"||type=="invalidate-irp"){
                if(irps.Remove(irpValue)){
                    var invalidation=new Dictionary<string,object>(row);
                    invalidation["type"]="invalidate-irp";invalidation.Add("irp",Pointer(irpValue));emit(invalidation);
                }
                if(type=="invalidate-irp")return null;
            }
            ulong file=Address(props,api,record,"FileObject");
            if(type=="create"){
                bool prior=files.Remove(file);var classification=PathClass((string)props.Read(api,record,"OpenPath"));
                bool selected=classification["fixtureTag"]!=null;
                if(selected){files.Add(file);Bound(files.Count,256);}
                if(!selected&&!prior)return null;
                row.Add("fileObject",Pointer(file));row.Add("irp",Pointer(irpValue));
                foreach(var item in classification)row.Add(item.Key,item.Value);return row;
            }
            if(type=="close"){
                if(!files.Remove(file))return null;
                row.Add("fileObject",Pointer(file));row.Add("irp",Pointer(irpValue));return row;
            }
            if(type=="flush"){
                ulong key=Address(props,api,record,"FileKey");
                if(!files.Contains(file)&&!names.Contains(key)&&!irps.ContainsKey(irpValue))return null;
                irps[irpValue]=file;Bound(irps.Count,8192);
                row.Add("irp",Pointer(irpValue));row.Add("fileObject",Pointer(file));row.Add("fileKey",Pointer(key));return row;
            }
            if(!files.Contains(file)&&!irps.ContainsKey(irpValue))return null;
            row.Add("irp",Pointer(irpValue));row.Add("fileObject",Pointer(file));
            row.Add("routine",Pointer(Address(props,api,record,"RoutineAddr")));
            row.Add("fileContext",Pointer(Address(props,api,record,"FileContext")));
            row.Add("callbackData",Pointer(Address(props,api,record,"CallbackDataPtr")));
            row.Add("majorFunction",(uint)props.Read(api,record,"MajorFunction"));
            if(type=="filter-complete")row.Add("initialTime",((ulong)props.Read(api,record,"InitialTime")).ToString(CultureInfo.InvariantCulture));
            if(type=="filter-failure")row.Add("status",(uint)props.Read(api,record,"Status"));
            return row;
        }
    }
}
