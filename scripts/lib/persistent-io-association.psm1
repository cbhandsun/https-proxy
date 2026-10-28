# Only scalar metadata from an already selected synthetic SQLite operation.
# Event-header PID/TID remain labelled as such: they are not inferred owners.
function Get-HpmIoAssociation {
    param([hashtable]$Fields, [Xml.XmlDocument]$Xml)
    $result = [ordered]@{ eventProcessId=$null; eventThreadId=$null; issuingThreadId=$null }
    function Read-ObservedId([string]$Text) {
        if ($Text -cmatch '\A0x[0-9a-fA-F]{1,8}\z') {
            $value = [uint32]::Parse($Text.Substring(2), [Globalization.NumberStyles]::AllowHexSpecifier, [Globalization.CultureInfo]::InvariantCulture)
        } elseif ($Text -cmatch '\A(?:0|[1-9][0-9]{0,9})\z') {
            $value = [uint32]::Parse($Text, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture)
        } else { throw 'persistent_io_association_refused' }
        if ($value -eq 0 -or $value -eq [uint32]::MaxValue) { return $null }
        return $value
    }
    $execution = $Xml.SelectNodes('/*[local-name()="Event"]/*[local-name()="System"]/*[local-name()="Execution"]')
    if ($execution.Count -gt 1) { throw 'persistent_io_association_refused' }
    if ($execution.Count -eq 1) {
        foreach ($pair in @(@('ProcessID','eventProcessId'), @('ThreadID','eventThreadId'))) {
            if ($execution[0].HasAttribute($pair[0])) { $result[$pair[1]] = Read-ObservedId $execution[0].GetAttribute($pair[0]) }
        }
    }
    $keys = @(@('IssuingThreadId','TTID') | Where-Object { $Fields.ContainsKey($_) })
    if ($keys.Count -gt 1) { throw 'persistent_io_association_refused' }
    if ($keys.Count -eq 1) { $result.issuingThreadId = Read-ObservedId ([string]$Fields[$keys[0]]) }
    return $result
}
Export-ModuleMember -Function Get-HpmIoAssociation
