Set-StrictMode -Version Latest
function New-HpmIoSchemaState { return @{events=0;named=0;unsupported=0;fieldCells=0;layouts=@{}} }
function Add-HpmIoSchemaRecord {
    param([hashtable]$State,[Guid]$Provider,[int]$Id,[int]$Version,[int]$Opcode,[string]$Text)
    if ($State.events -ge 1000000 -or $Id -lt 0 -or $Id -gt 65535 -or $Version -lt 0 -or $Version -gt 255 -or $Opcode -lt 0 -or $Opcode -gt 255 -or $Text.Length -gt 65536) { throw 'io_schema_failed' }
    $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null;$settings.MaxCharactersInDocument=65536
    $reader=[Xml.XmlReader]::Create([IO.StringReader]::new($Text),$settings)
    $xml=[Xml.XmlDocument]::new();$xml.XmlResolver=$null
    try{$xml.Load($reader)}finally{$reader.Dispose()}
    if($xml.DocumentElement.LocalName -cne 'Event'){throw 'io_schema_failed'}
    $fields=@();$names=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $nodes=$xml.SelectNodes('/*[local-name()="Event"]/*[local-name()="EventData"]/* | /*[local-name()="Event"]/*[local-name()="BinaryEventData"] | /*[local-name()="Event"]/*[local-name()="ProcessingErrorData"]/*[local-name()="EventPayload"]')
    if($nodes.Count -gt 64){throw 'io_schema_failed'}
    $named=$nodes.Count -gt 0
    foreach($node in $nodes){
        $name=$node.GetAttribute('Name');$kind=$node.LocalName
        if($kind -cne 'Data' -or [string]::IsNullOrEmpty($name)){$named=$false;$name='';$kind='unnamed_payload'}
        elseif($name -cnotmatch '\A[A-Za-z_][A-Za-z0-9_]{0,63}\z' -or -not $names.Add($name)){throw 'io_schema_failed'}
        if($node.ChildNodes.Count -gt 1 -or ($node.ChildNodes.Count -eq 1 -and $node.FirstChild.NodeType -notin @([Xml.XmlNodeType]::Text,[Xml.XmlNodeType]::CDATA))){throw 'io_schema_failed'}
        $fields+=@{name=$name;kind=$kind;type='xml_text_unknown';minChars=$node.InnerText.Length;maxChars=$node.InnerText.Length}
    }
    # Field values and their hashes are never retained. Layout hash excludes lengths.
    $shape=ConvertTo-Json -InputObject @($fields|ForEach-Object{[ordered]@{name=$_.name;kind=$_.kind;type=$_.type}}) -Depth 4 -Compress
    $layout=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($shape))).ToLowerInvariant()
    $key=$Provider.ToString()+':'+$Id+':'+$Version+':'+$Opcode+':'+$layout
    if(-not $State.layouts.ContainsKey($key)){
        if($State.layouts.Count -ge 64 -or $State.fieldCells+$fields.Count -gt 256){throw 'io_schema_failed'}
        $State.fieldCells+=$fields.Count
        $State.layouts[$key]=@{provider=$Provider.ToString();id=$Id;version=$Version;opcode=$Opcode;layoutSha256=$layout;namedPayload=$named;count=0;fields=$fields}
    }
    $row=$State.layouts[$key];$row.count++
    for($i=0;$i -lt $fields.Count;$i++){$row.fields[$i].minChars=[Math]::Min($row.fields[$i].minChars,$fields[$i].minChars);$row.fields[$i].maxChars=[Math]::Max($row.fields[$i].maxChars,$fields[$i].maxChars)}
    $State.events++;if($named){$State.named++}else{$State.unsupported++}
}
function Get-HpmIoSchemaSummary([hashtable]$State){
    return @{events=$State.events;namedPayloadEvents=$State.named;unsupportedPayloadEvents=$State.unsupported;layouts=@($State.layouts.GetEnumerator()|Sort-Object Key|ForEach-Object{$_.Value});fieldTypesVerified=$false;filterAttributionQualified=$false;traceCompletenessVerified=$false}
}
Export-ModuleMember -Function New-HpmIoSchemaState,Add-HpmIoSchemaRecord,Get-HpmIoSchemaSummary
