'use strict';
// Installed registered exports only. Input/output carry credentials solely over
// anonymous pipes. The helper never writes execution-token caches or logs.
const SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$stage='input'
try {
 $raw=[Console]::ReadLine()
 if (!$raw -or $raw.Length -gt 12000) { throw 'invalid_input' }
 $inputValue=$raw | ConvertFrom-Json
 $src=@'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TianxiAuthBridge {
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate int Callback(IntPtr category,IntPtr content,IntPtr response);
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate int Initialize(IntPtr input,Callback callback);
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate int Action(IntPtr category,IntPtr content,out IntPtr response);
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void Free(IntPtr response);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool SetDllDirectory(string path);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr LoadLibraryEx(string path,IntPtr file,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr AddDllDirectory(string path);
 [DllImport("kernel32.dll",CharSet=CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module,string name);
 static Action action; static Free free; static Callback callback;
 // Rejection must leave the caller-owned response slot untouched. Clearing it
 // caused an observed native GETLOGININFO crash in this installed SDK.
 public static int RejectHostRequest(IntPtr category,IntPtr content,IntPtr response) { return 1; }
 static IntPtr Utf8(string text) { byte[] bytes=Encoding.UTF8.GetBytes(text+"\0"); IntPtr p=Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes,0,p,bytes.Length); return p; }
 static string Read(IntPtr p) { int n=0; while(n<65536 && Marshal.ReadByte(p,n)!=0)n++; if(n==65536)throw new Exception("oversized"); byte[] b=new byte[n];Marshal.Copy(p,b,0,n);return Encoding.UTF8.GetString(b); }
 public static void Open(string root,string config) {
  if(!SetDllDirectory(root) || AddDllDirectory(root)==IntPtr.Zero || AddDllDirectory(root+"\\lsf")==IntPtr.Zero || LoadLibraryEx(root+"\\lsf\\LsfSdk.dll",IntPtr.Zero,0x1100)==IntPtr.Zero)throw new Exception("load_failed");
  IntPtr module=LoadLibraryEx(root+"\\WrapPlugin.dll",IntPtr.Zero,0x1100);if(module==IntPtr.Zero)throw new Exception("load_failed");
  action=(Action)Marshal.GetDelegateForFunctionPointer(GetProcAddress(module,"pcm_plugin_action"),typeof(Action));
  free=(Free)Marshal.GetDelegateForFunctionPointer(GetProcAddress(module,"pcm_plugin_buffer_free"),typeof(Free));
  Initialize init=(Initialize)Marshal.GetDelegateForFunctionPointer(GetProcAddress(module,"pcm_plugin_ininitialize"),typeof(Initialize));
  callback=RejectHostRequest;
  IntPtr input=Utf8(config);try {if(init(input,callback)!=0)throw new Exception("initialize_failed");}finally{Marshal.FreeHGlobal(input);}
 }
 public static string Invoke(string category,string content) {
  IntPtr c=Utf8(category),p=Utf8(content),response=IntPtr.Zero;
  try {if(action(c,p,out response)!=0)throw new Exception("action_failed");return response==IntPtr.Zero?"":Read(response);}
  finally {if(response!=IntPtr.Zero)free(response);Marshal.FreeHGlobal(c);Marshal.FreeHGlobal(p);}
 }
}
'@
 $stage='compile'
 Add-Type -TypeDefinition $src
 $root='C:\Program Files\Lenovo\AIAgent'
 $stage='initialize'
 [TianxiAuthBridge]::Open($root,(@{RegistryPath='Software\Lenovo\AIAgent';InstallPath=$root}|ConvertTo-Json -Compress))
 $stage='sso'
 [void][TianxiAuthBridge]::Invoke('NEWPLUGIN_WRAPPLUGIN_LIDINITLIZE',($inputValue.initPayload|ConvertTo-Json -Compress))
 function Assert-Login {
  $login=[TianxiAuthBridge]::Invoke('NEWPLUGIN_WRAPPLUGIN_GETLOGININFO','{}')|ConvertFrom-Json
  if($login.data){$login=$login.data}
  $id=$login.loginid;if(!$id){$id=$login.lenovoId}
  if($login.loginstatus -ne 1 -or $id -cne $inputValue.userId){throw 'identity_changed'}
 }
 $stage='login'
 $matched=$false
 for($i=0;$i -lt 8;$i++){Start-Sleep -Milliseconds 1000;try{Assert-Login;$matched=$true;break}catch{}}
 if(!$matched){throw 'identity_missing'}
 $stage='v4'
 $token=[TianxiAuthBridge]::Invoke('NEWPLUGIN_WRAPPLUGIN_GETTOKENV4','{}')
 if($token.StartsWith('"')){$token=$token|ConvertFrom-Json}
 if($token -notmatch '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'){throw 'token_invalid'}
 $payload=$token.Split('.')[1].Replace('-','+').Replace('_','/')
 $payload=$payload.PadRight($payload.Length+((4-$payload.Length%4)%4),'=')
 $claims=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))|ConvertFrom-Json
 if([double]$claims.exp -le [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()+60){
  Assert-Login
  $token=[TianxiAuthBridge]::Invoke('NEWPLUGIN_WRAPPLUGIN_GETTOKENV4','1')
  if($token.StartsWith('"')){$token=$token|ConvertFrom-Json}
 }
 $stage='sign'
 $signature=[TianxiAuthBridge]::Invoke('NEWPLUGIN_WRAPPLUGIN_APP_RSASIGN',$inputValue.canonical)
 Assert-Login
 @{ok=$true;token=$token;signature=$signature}|ConvertTo-Json -Compress
} catch { [Console]::WriteLine((@{ok=$false;stage=$stage}|ConvertTo-Json -Compress)) }
`;
module.exports = { SCRIPT };
