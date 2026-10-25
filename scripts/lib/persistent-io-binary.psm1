# Fixed x64 layouts: Microsoft FileIo_Name/SimpleOp/OpEnd and PerfView's
# KernelTraceEventParser. Unknown versions fail instead of guessing offsets.
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
        if ($Opcode -eq 73) {
            if ($Version -eq 2 -and $bytes.Length -eq 32) { $offset = 24 }
            elseif ($Version -eq 3 -and $bytes.Length -eq 28) { $offset = 16 }
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
