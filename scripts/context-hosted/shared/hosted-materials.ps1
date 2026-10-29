Set-StrictMode -Version Latest

# Filesystem-only helper. No networking, hosts, firewall or certificate commands.
function Initialize-HpmN08ArtifactLease {
    if ('HpmN08ArtifactLease' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public sealed class HpmN08ArtifactLease : IDisposable {
    [StructLayout(LayoutKind.Sequential)] private struct Info {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
    private SafeFileHandle handle; private Info original; private bool directory;
    private static SafeFileHandle Open(string path) { return CreateFile(path, 0, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero); }
    private static Info Read(SafeFileHandle file, bool dir) {
        Info value;
        if (file.IsInvalid || !GetFileInformationByHandle(file, out value) || (value.Attributes & 0x400) != 0 ||
            ((value.Attributes & 0x10) != 0) != dir || (!dir && value.Links != 1)) throw new InvalidOperationException("n08_material_rejected");
        return value;
    }
    public HpmN08ArtifactLease(string path, bool dir) {
        directory=dir; handle=Open(path);
        try { original=Read(handle, dir); } catch { handle.Dispose(); throw; }
    }
    public void Verify(string path) {
        if (handle.IsClosed) throw new InvalidOperationException("n08_material_rejected");
        using (var current=Open(path)) {
            var value=Read(current,directory);
            if (value.Volume!=original.Volume || value.IndexHigh!=original.IndexHigh || value.IndexLow!=original.IndexLow)
                throw new InvalidOperationException("n08_material_rejected");
        }
    }
    public void Dispose() { if (handle!=null) handle.Dispose(); }
}
'@
}

function Assert-HpmN08MaterialPath {
    param([string]$Path, [bool]$Directory)
    if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\')) { throw 'n08_material_rejected' }
    $current = [IO.Path]::GetFullPath($Path)
    $first = $true
    while ($true) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            ($first -and $item.PSIsContainer -ne $Directory) -or (-not $first -and -not $item.PSIsContainer)) { throw 'n08_material_rejected' }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { break }
        $first = $false; $current = $parent
    }
}

function Remove-HpmN08CreatedMaterials {
    param([string]$Root, [bool]$Created, $DirectoryLease, [hashtable]$MaterialLeases)
    # Collision/rejection must never delete material from an existing directory.
    if (-not $Created) { return }
    if ($null -eq $DirectoryLease -or $null -eq $MaterialLeases) { throw 'n08_material_rejected' }
    Assert-HpmN08MaterialPath $Root $true
    $DirectoryLease.Verify($Root)
    foreach ($name in @('server.pfx', '.pfx-password', 'ca.pem')) {
        if (-not $MaterialLeases.ContainsKey($name)) { continue }
        $file = Join-Path $Root $name
        Assert-HpmN08MaterialPath $file $false
        $DirectoryLease.Verify($Root)
        $MaterialLeases[$name].Verify($file)
        $MaterialLeases[$name].Dispose()
        Remove-Item -LiteralPath $file -Force -ErrorAction Stop
    }
}
