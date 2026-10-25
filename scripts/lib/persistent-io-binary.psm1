# Fixed x64 layouts: Microsoft FileIo_Name/SimpleOp/OpEnd and PerfView's
# KernelTraceEventParser. Unknown versions fail instead of guessing offsets.
# ReadWrite/Info layouts also follow Microsoft's FileIo_ReadWrite/FileIo_Info
# and https://github.com/microsoft/perfview/blob/main/src/TraceEvent/Parsers/KernelTraceEventParser.cs
function ConvertFrom-HpmFileIoBinary {
    param([string]$Hex, [int]$Opcode, [int]$Version)
    try {
        if (-not [BitConverter]::IsLittleEndian -or [string]::IsNullOrEmpty($Hex) -or $Hex.Length -gt 32768 -or $Hex.Length % 2 -ne 0 -or $Hex -cnotmatch '\A[0-9a-fA-F]+\z') { throw 'invalid' }
        $bytes = [Convert]::FromHexString($Hex)
        if ($Opcode -in @(0,32,35,36)) {
            if ($Version -lt 0 -or $Version -gt 3 -or $bytes.Length -lt 10 -or $bytes.Length % 2 -ne 0 -or $bytes[-1] -ne 0 -or $bytes[-2] -ne 0) { throw 'invalid' }
            $text = [Text.UnicodeEncoding]::new($false,$false,$true).GetString($bytes,8,$bytes.Length-10)
            if ($text.Contains([char]0)) { throw 'invalid' }
            return @{ FileObject = '0x' + [BitConverter]::ToUInt64($bytes,0).ToString('x16'); FileName = $text }
        }
        # Unreported operations can only invalidate a previous IRP association.
        # Read their fixed header; never export their variable path payload.
        if ($Opcode -in @(64,72,77)) {
            if ($Version -notin @(2,3)) { throw 'invalid' }
            $minimum = if ($Opcode -eq 64) { if ($Version -eq 2) {38} else {34} } else { if ($Version -eq 2) {46} else {42} }
            if ($bytes.Length -lt $minimum -or $bytes.Length % 2 -ne 0 -or $bytes[-1] -ne 0 -or $bytes[-2] -ne 0) { throw 'invalid' }
            return @{ IrpPtr = '0x' + [BitConverter]::ToUInt64($bytes,0).ToString('x16') }
        }
        if ($Opcode -in @(65,66,73)) {
            if ($Version -eq 2 -and $bytes.Length -eq 32) { $offset = 24 }
            elseif ($Version -eq 3 -and $bytes.Length -eq 28) { $offset = 16 }
            else { throw 'invalid' }
            return @{ IrpPtr = '0x' + [BitConverter]::ToUInt64($bytes,0).ToString('x16'); FileKey = '0x' + [BitConverter]::ToUInt64($bytes,$offset).ToString('x16') }
        }
        if ($Opcode -in @(67,68)) {
            if ($Version -eq 2 -and $bytes.Length -eq 48) { $offset = 32 }
            elseif ($Version -eq 3 -and $bytes.Length -in @(44,48)) { $offset = 24 }
            else { throw 'invalid' }
            return @{ IrpPtr = '0x' + [BitConverter]::ToUInt64($bytes,8).ToString('x16'); FileKey = '0x' + [BitConverter]::ToUInt64($bytes,$offset).ToString('x16') }
        }
        if ($Opcode -in @(69,70,71,74,75)) {
            if ($Version -eq 2 -and $bytes.Length -eq 44) { $offset = 24 }
            elseif ($Version -eq 3 -and $bytes.Length -eq 40) { $offset = 16 }
            else { throw 'invalid' }
            return @{ IrpPtr = '0x' + [BitConverter]::ToUInt64($bytes,0).ToString('x16'); FileKey = '0x' + [BitConverter]::ToUInt64($bytes,$offset).ToString('x16') }
        }
        if ($Opcode -eq 76 -and $Version -in @(2,3) -and $bytes.Length -eq 20) {
            return @{ IrpPtr = '0x' + [BitConverter]::ToUInt64($bytes,0).ToString('x16'); NtStatus = [BitConverter]::ToUInt32($bytes,16).ToString() }
        }
        throw 'invalid'
    } catch { throw 'persistent_io_binary_refused' }
}
Export-ModuleMember -Function ConvertFrom-HpmFileIoBinary
