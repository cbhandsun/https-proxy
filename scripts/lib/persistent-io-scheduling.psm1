Set-StrictMode -Version Latest

function New-HpmIoSchedulingState {
    return @{ bound = [Collections.Generic.HashSet[uint32]]::new() }
}
function ConvertTo-HpmIoThreadId {
    param([string]$Text)
    if ($Text -cmatch '\A0x[0-9a-fA-F]{1,8}\z') {
        return [UInt32]::Parse($Text.Substring(2), [Globalization.NumberStyles]::AllowHexSpecifier, [Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Text -cnotmatch '\A(?:0|[1-9][0-9]{0,9})\z') { throw 'persistent_io_scheduling_refused' }
    return [UInt32]::Parse($Text, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture)
}
function Write-HpmIoSchedulingRecord {
    param([string]$Type, [uint32]$ThreadId, [long]$TimeMs, [string]$Name = '')
    [ordered]@{ type = $Type; key = ('0x' + $ThreadId.ToString('x8')); timeMs = $TimeMs; name = $Name } | ConvertTo-Json -Compress
}
function Add-HpmIoSchedulingBinding {
    param([hashtable]$Fields, [Xml.XmlDocument]$Xml, [long]$TimeMs, [hashtable]$State)
    try {
        if ($TimeMs -lt 0) { throw 'invalid' }
        $keys = @(@('IssuingThreadId','TTID') | Where-Object { $Fields.ContainsKey($_) })
        if ($keys.Count -gt 1) { throw 'invalid' }
        $id = if ($keys.Count -eq 1) { ConvertTo-HpmIoThreadId ([string]$Fields[$keys[0]]) } else {
            $execution = $Xml.SelectNodes('/*[local-name()="Event"]/*[local-name()="System"]/*[local-name()="Execution"]')
            if ($execution.Count -ne 1) { return }
            ConvertTo-HpmIoThreadId $execution[0].GetAttribute('ThreadID')
        }
        # A missing/placeholder issuer is unobserved, never guessed from PID.
        if ($id -eq 0 -or $id -eq [UInt32]::MaxValue -or $State.bound.Contains($id)) { return }
        if ($State.bound.Count -ge 256) { throw 'invalid' }
        [void]$State.bound.Add($id)
        Write-HpmIoSchedulingRecord 'schedule-bind' $id $TimeMs
    } catch { throw 'persistent_io_scheduling_refused' }
}

# Fixed public prefix layouts: Microsoft CSwitch and PerfView's
# CSwitchTraceData / ThreadTraceData. No stack, address, name or process memory
# is decoded. Thread starts/ends invalidate a binding before ID reuse.
# Hosted Windows emitted v5 (153 explicit version refusals). The documented
# fixed prefixes remain at the same offsets; unknown v6+ stays unobserved.
# https://learn.microsoft.com/en-us/windows/win32/etw/cswitch
# https://github.com/microsoft/perfview/blob/main/src/TraceEvent/Parsers/KernelTraceEventParser.cs
function ConvertFrom-HpmThreadSchedulingBinary {
    param([string]$Hex, [int]$Opcode, [int]$Version)
    try {
        if (-not [BitConverter]::IsLittleEndian -or $Version -notin @(2,3,4,5) -or
            [string]::IsNullOrEmpty($Hex) -or $Hex.Length -gt 8192 -or $Hex.Length % 2 -ne 0 -or
            $Hex -cnotmatch '\A[0-9a-fA-F]+\z') { throw 'invalid' }
        $bytes = [Convert]::FromHexString($Hex)
        if ($Opcode -in @(1,2)) {
            if ($bytes.Length -lt 8) { throw 'invalid' }
            return @{ TThreadId = [BitConverter]::ToUInt32($bytes,4) }
        }
        if ($Opcode -ne 36 -or $bytes.Length -lt 24 -or $bytes.Length -gt 64 -or
            ($Version -eq 2 -and $bytes.Length -ne 24)) { throw 'invalid' }
        return @{ NewThreadId = [BitConverter]::ToUInt32($bytes,0); OldThreadId = [BitConverter]::ToUInt32($bytes,4);
            OldThreadState = [uint32]$bytes[14]; OldThreadWaitReason = [uint32]$bytes[12] }
    } catch { throw 'persistent_io_scheduling_refused' }
}
function ConvertTo-HpmThreadSchedulingRecord {
    param([string]$Text, [int]$Opcode, [long]$TimeMs, [hashtable]$State)
    $reader = $null
    try {
        if ($Text.Length -gt 65536 -or $TimeMs -lt 0 -or $Opcode -notin @(1,2,36)) { throw 'invalid' }
        $settings = [Xml.XmlReaderSettings]::new(); $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit; $settings.XmlResolver = $null
        $reader = [Xml.XmlReader]::Create([IO.StringReader]::new($Text), $settings)
        $xml = [Xml.XmlDocument]::new(); $xml.XmlResolver = $null; $xml.Load($reader)
        $fields = @{}
        foreach ($item in $xml.SelectNodes('//*[local-name()="EventData"]/*[local-name()="Data"]')) {
            $name = $item.GetAttribute('Name')
            if ($fields.ContainsKey($name)) { throw 'invalid' }
            $fields[$name] = $item.InnerText
        }
        $version = $xml.SelectNodes('/*[local-name()="Event"]/*[local-name()="System"]/*[local-name()="Version"]')
        if ($version.Count -ne 1 -or $version[0].InnerText -cnotmatch '\A[2-5]\z') { throw 'invalid' }
        $binary = $xml.SelectNodes('/*[local-name()="Event"]/*[local-name()="BinaryEventData"] | /*[local-name()="Event"]/*[local-name()="EventData"]/*[local-name()="Binary"] | /*[local-name()="Event"]/*[local-name()="ProcessingErrorData"]/*[local-name()="EventPayload"]')
        if ($binary.Count -gt 0) {
            if ($binary.Count -ne 1 -or $fields.Count -ne 0) { throw 'invalid' }
            $fields = ConvertFrom-HpmThreadSchedulingBinary $binary[0].InnerText $Opcode ([int]$version[0].InnerText)
        } elseif ($fields.Count -eq 1 -and $fields.ContainsKey('')) {
            $fields = ConvertFrom-HpmThreadSchedulingBinary $fields[''] $Opcode ([int]$version[0].InnerText)
        }
        Write-HpmThreadSchedulingFields $fields $Opcode $TimeMs $State
    } catch { throw 'persistent_io_scheduling_refused' } finally { if ($null -ne $reader) { $reader.Dispose() } }
}
function Write-HpmThreadSchedulingFields {
    param([hashtable]$Fields, [int]$Opcode, [long]$TimeMs, [hashtable]$State)
        if ($Opcode -in @(1,2)) {
            $id = ConvertTo-HpmIoThreadId ([string]$fields['TThreadId'])
            if ($State.bound.Remove($id)) { Write-HpmIoSchedulingRecord 'schedule-retire' $id $TimeMs }
            return
        }
        $newId = ConvertTo-HpmIoThreadId ([string]$fields['NewThreadId'])
        $oldId = ConvertTo-HpmIoThreadId ([string]$fields['OldThreadId'])
        if ($State.bound.Contains($newId)) { Write-HpmIoSchedulingRecord 'schedule-in' $newId $TimeMs }
        if (-not $State.bound.Contains($oldId)) { return }
        $oldState = ConvertTo-HpmIoThreadId ([string]$fields['OldThreadState'])
        $reason = ConvertTo-HpmIoThreadId ([string]$fields['OldThreadWaitReason'])
        if ($oldState -gt 255 -or $reason -gt 255) { throw 'invalid' }
        if ($State.bound.Contains($oldId)) {
            if ($oldState -eq 4 -or $oldId -eq $newId) {
                [void]$State.bound.Remove($oldId)
                Write-HpmIoSchedulingRecord 'schedule-retire' $oldId $TimeMs
            } else { Write-HpmIoSchedulingRecord 'schedule-out' $oldId $TimeMs ($oldState.ToString() + ':' + $reason.ToString()) }
        }
}

# Native EventRecord scalar values avoid rendering XML for every global CSwitch.
# Unsupported metadata invalidates all selected bindings explicitly; no interval
# can span an unobserved switch or an unknown thread retirement.
function ConvertTo-HpmThreadSchedulingEvent {
    param($Record, [int]$Opcode, [long]$TimeMs, [hashtable]$State)
    if ($State.bound.Count -eq 0) { return }
    $shapeVersion='x';$shapeCount='x';$shapeType='none';$shapeStage='header'
    try {
        $version=[int]$Record.Version
        if($version -ge 0 -and $version -le 255){$shapeVersion=$version.ToString()}
        $shapeStage='version'
        if ($TimeMs -lt 0 -or $Opcode -notin @(1,2,36) -or [int]$Record.Version -notin @(2,3,4,5)) { throw 'invalid' }
        $shapeStage='properties'
        $properties = $Record.Properties
        if($properties.Count -ge 0 -and $properties.Count -le 64){$shapeCount=$properties.Count.ToString()}
        $fields = @{}
        if ($properties.Count -eq 1) {
            $shapeStage='payload'
            $raw = $properties[0].Value
            $shapeType=if($raw -is [byte[]]){'bytes'}elseif($raw -is [string]){'string'}else{'other'}
            $hex = if ($raw -is [byte[]]) { [Convert]::ToHexString($raw) } elseif ($raw -is [string]) { $raw } else { throw 'invalid' }
            $fields = ConvertFrom-HpmThreadSchedulingBinary $hex $Opcode ([int]$Record.Version)
        } else {
            $shapeStage='scalar'
            $indices = if ($Opcode -eq 36) { @{ NewThreadId=0;OldThreadId=1;OldThreadState=8;OldThreadWaitReason=6 } } else { @{ TThreadId=1 } }
            foreach ($key in $indices.Keys) {
                $index = $indices[$key]
                if ($index -ge $properties.Count) { throw 'invalid' }
                $value = $properties[$index].Value
                $shapeType=if($value -is [byte]){'byte'}elseif($value -is [sbyte]){'sbyte'}elseif($value -is [uint32]){'u32'}elseif($value -is [int32]){'i32'}elseif($value -is [uint64]){'u64'}elseif($value -is [int64]){'i64'}elseif($value -is [uint16]){'u16'}elseif($value -is [int16]){'i16'}else{'other'}
                if ($value -isnot [byte] -and $value -isnot [sbyte] -and $value -isnot [uint32] -and $value -isnot [int32]) { throw 'invalid' }
                if ($value -lt 0) { throw 'invalid' }
                $fields[$key] = [uint32]$value
            }
        }
        $shapeStage='fields'
        Write-HpmThreadSchedulingFields $fields $Opcode $TimeMs $State
    } catch {
        $State.bound.Clear()
        Write-HpmIoSchedulingRecord 'schedule-unmapped' 1 $TimeMs ('v'+$shapeVersion+':p'+$shapeCount+':t'+$shapeType+':e'+$shapeStage)
    }
}

Export-ModuleMember -Function New-HpmIoSchedulingState, Add-HpmIoSchedulingBinding, ConvertFrom-HpmThreadSchedulingBinary, ConvertTo-HpmThreadSchedulingRecord, ConvertTo-HpmThreadSchedulingEvent
