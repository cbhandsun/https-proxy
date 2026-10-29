Set-StrictMode -Version Latest
function Assert-HpmTdhKeys($Element,[string[]]$Expected) {
    if($Element.ValueKind -ne [Text.Json.JsonValueKind]::Object){throw 'refused'}
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach($property in $Element.EnumerateObject()){
        if($property.Name -cnotin $Expected -or -not $seen.Add($property.Name)){throw 'refused'}
    }
    if($seen.Count -ne $Expected.Count){throw 'refused'}
}
function ConvertFrom-HpmTdhMetadataSummary([string]$Text) {
    $document=$null
    try {
        if([string]::IsNullOrEmpty($Text) -or [Text.Encoding]::UTF8.GetByteCount($Text) -gt 16384){throw 'refused'}
        $document=[Text.Json.JsonDocument]::Parse($Text)
        $root=$document.RootElement
        Assert-HpmTdhKeys $root @('schemaVersion','scope','sampledMetadataOnly','eventValuesDecoded','fieldTypesVerified','filterAttributionQualified','traceCompletenessVerified','realModelRequests','events','selectedEvents','unsupportedLayouts','layouts')
        if($root.GetProperty('schemaVersion').GetInt32() -ne 1 -or $root.GetProperty('scope').GetString() -cne 'sampled_native_event_metadata' -or -not $root.GetProperty('sampledMetadataOnly').GetBoolean() -or $root.GetProperty('realModelRequests').GetInt32() -ne 0){throw 'refused'}
        foreach($key in @('eventValuesDecoded','fieldTypesVerified','filterAttributionQualified','traceCompletenessVerified')){if($root.GetProperty($key).GetBoolean()){throw 'refused'}}
        $events=$root.GetProperty('events').GetInt32();$selected=$root.GetProperty('selectedEvents').GetInt32();$unsupported=$root.GetProperty('unsupportedLayouts').GetInt32()
        if($events -lt 1 -or $events -gt 1000000 -or $selected -lt 1 -or $selected -gt $events){throw 'refused'}
        $layouts=$root.GetProperty('layouts')
        if($layouts.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $layouts.GetArrayLength() -lt 1 -or $layouts.GetArrayLength() -gt 64){throw 'refused'}
        $ids=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);$cells=0;$total=0;$unsupportedCount=0
        foreach($layout in $layouts.EnumerateArray()){
            Assert-HpmTdhKeys $layout @('provider','id','version','opcode','headerFlags','descriptorIdentity','metadataProvider','eventClass','decodingSource','metadataId','metadataVersion','metadataOpcode','unsupported','count','fields')
            if($layout.GetProperty('provider').GetString() -cne '90cbdc39-4a3e-11d1-84f4-0000f80464e3'){throw 'refused'}
            foreach($key in @('id','headerFlags')){$n=$layout.GetProperty($key).GetInt32();if($n -lt 0 -or $n -gt 65535){throw 'refused'}}
            $version=$layout.GetProperty('version').GetInt32();$opcode=$layout.GetProperty('opcode').GetInt32()
            if($version -lt 0 -or $version -gt 255 -or $opcode -lt 96 -or $opcode -gt 101){throw 'refused'}
            $id=$layout.GetProperty('descriptorIdentity').GetString()
            if($id -cnotmatch '\A[a-f0-9]{64}\z' -or -not $ids.Add($id)){throw 'refused'}
            $count=$layout.GetProperty('count').GetInt32();if($count -lt 1 -or $count -gt $selected){throw 'refused'};$total+=$count
            foreach($key in @('metadataProvider','eventClass')){
                $value=$layout.GetProperty($key)
                if($value.ValueKind -ne [Text.Json.JsonValueKind]::Null -and $value.GetString() -cnotmatch '\A[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\z'){throw 'refused'}
            }
            $decoding=$layout.GetProperty('decodingSource')
            if($decoding.ValueKind -ne [Text.Json.JsonValueKind]::Null){$n=$decoding.GetInt32();if($n -lt 0 -or $n -gt 3){throw 'refused'}}
            foreach($key in @('metadataId','metadataVersion','metadataOpcode')){
                $value=$layout.GetProperty($key)
                if($value.ValueKind -ne [Text.Json.JsonValueKind]::Null){$n=$value.GetInt32();if($n -lt 0 -or $n -gt $(if($key -ceq 'metadataId'){65535}else{255})){throw 'refused'}}
            }
            $reason=$layout.GetProperty('unsupported');$fields=$layout.GetProperty('fields')
            if($fields.ValueKind -ne [Text.Json.JsonValueKind]::Array -or $fields.GetArrayLength() -gt 64){throw 'refused'}
            if($reason.ValueKind -ne [Text.Json.JsonValueKind]::Null){
                if($reason.GetString() -cnotin @('metadata_unavailable','metadata_buffer_limit','unknown_decoding_source','wpp_context_required','nested_struct','dynamic_count_or_length','custom_schema','wbem_xml_fragment','unknown_property_flags','empty_metadata','field_name_policy') -or $fields.GetArrayLength() -ne 0){throw 'refused'}
                $unsupportedCount++
            }elseif($fields.GetArrayLength() -eq 0 -or $decoding.ValueKind -eq [Text.Json.JsonValueKind]::Null -or $layout.GetProperty('metadataProvider').ValueKind -eq [Text.Json.JsonValueKind]::Null -or $layout.GetProperty('eventClass').ValueKind -eq [Text.Json.JsonValueKind]::Null){throw 'refused'}
            $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            foreach($field in $fields.EnumerateArray()){
                Assert-HpmTdhKeys $field @('name','inType','outType')
                $name=$field.GetProperty('name').GetString()
                if($name -cnotmatch '\A[A-Za-z_][A-Za-z0-9_]{0,63}\z' -or -not $names.Add($name)){throw 'refused'}
                foreach($key in @('inType','outType')){$n=$field.GetProperty($key).GetInt32();if($n -lt 0 -or $n -gt 65535){throw 'refused'}}
                $cells++;if($cells -gt 256){throw 'refused'}
            }
        }
        if($total -ne $selected -or $unsupportedCount -ne $unsupported){throw 'refused'}
        return ConvertFrom-Json -InputObject $Text -AsHashtable
    }catch{throw 'io_schema_tdh_failed'}finally{if($null -ne $document){$document.Dispose()}}
}
function ConvertFrom-HpmTdhMetadataFailure([string]$Text) {
    $document=$null
    try {
        if([string]::IsNullOrEmpty($Text) -or [Text.Encoding]::UTF8.GetByteCount($Text) -gt 1024){throw 'refused'}
        $document=[Text.Json.JsonDocument]::Parse($Text);$root=$document.RootElement
        Assert-HpmTdhKeys $root @('schemaVersion','scope','phase','status')
        if($root.GetProperty('schemaVersion').GetInt32() -ne 1 -or $root.GetProperty('scope').GetString() -cne 'sampled_native_event_metadata_failure' -or $root.GetProperty('phase').GetString() -cnotin @('abi','open','process','information-size','information-read','metadata','close','callback','serialization','cleanup','path-platform','path-shape','path-open','path-information','path-type','path-links','path-size','path-closed','path-identity','callback-record-null','callback-event-limit','callback-deadline','callback-header-size','callback-layout-limit','callback-field-limit','metadata-bounds','metadata-buffer','metadata-array','metadata-name-offset','metadata-name-termination','metadata-name-encoding','metadata-name-duplicate')){throw 'refused'}
        $status=$root.GetProperty('status')
        if($status.ValueKind -ne [Text.Json.JsonValueKind]::Null){$null=$status.GetUInt32()}
        return ConvertFrom-Json -InputObject $Text -AsHashtable
    }catch{throw 'io_schema_tdh_failed'}finally{if($null -ne $document){$document.Dispose()}}
}
Export-ModuleMember -Function ConvertFrom-HpmTdhMetadataSummary,ConvertFrom-HpmTdhMetadataFailure
