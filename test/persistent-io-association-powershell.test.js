'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('actual PowerShell retains payload issuer independently of event header and refuses malformed identities', () => {
  const file = path
    .resolve(__dirname, '../scripts/lib/persistent-io-recording.psm1')
    .replaceAll("'", "''");
  const code = `
    $ErrorActionPreference='Stop'
    $module=Import-Module '${file}' -PassThru -Force
    & $module {
      function XmlEvent($execution,$fields) {
        '<Event><System>'+ $execution +'</System><EventData>'+ ($fields.GetEnumerator()|ForEach-Object {'<Data Name="'+$_.Key+'">'+[Security.SecurityElement]::Escape([string]$_.Value)+'</Data>'}) +'</EventData></Event>'
      }
      function Fresh { @{names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);irps=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)} }
      foreach($header in @('', '<Execution ProcessID="0" ThreadID="4294967295"/>', '<Execution ProcessID="123" ThreadID="456"/>')) {
        foreach($issuer in @($null,'0','4294967295','789','0x315')) {
          $state=Fresh;[void]$state.names.Add('0x0000000000000010')
          $fields=@{IrpPtr='0x20';FileKey='0x10'};if($null -ne $issuer){$fields.IssuingThreadId=$issuer}
          $record=ConvertTo-HpmPersistentIoRecord (XmlEvent $header $fields) 73 10 $state|ConvertFrom-Json
          if($record.type -cne 'flush' -or @($record.association.PSObject.Properties).Count -ne 3){throw 'association_shape_failed'}
          $expected=if($issuer -in @('789','0x315')){789}else{$null}
          if($record.association.issuingThreadId -ne $expected){throw 'payload_issuer_lost'}
          if($header.Contains('123')) {
            if($record.association.eventProcessId -ne 123 -or $record.association.eventThreadId -ne 456){throw 'header_identity_lost'}
          } elseif($null -ne $record.association.eventProcessId -or $null -ne $record.association.eventThreadId){throw 'missing_identity_guessed'}
        }
      }
      foreach($bad in @('PRIVATE','-1','01','4294967296','1.5')) {
        foreach($mode in @('issuer','header')) {
          $state=Fresh;[void]$state.names.Add('0x0000000000000010')
          $fields=@{IrpPtr='0x20';FileKey='0x10'};$header=''
          if($mode -ceq 'issuer'){$fields.IssuingThreadId=$bad}else{$header='<Execution ProcessID="'+$bad+'"/>'}
          $refused=$false;try{ConvertTo-HpmPersistentIoRecord (XmlEvent $header $fields) 73 10 $state|Out-Null}catch{$refused=$true}
          if(-not $refused){throw 'invalid_identity_accepted'}
        }
      }
      foreach($header in @('<Execution ProcessID="1"/><Execution ProcessID="2"/>')) {
        $state=Fresh;[void]$state.names.Add('0x0000000000000010');$refused=$false
        try{ConvertTo-HpmPersistentIoRecord (XmlEvent $header @{IrpPtr='0x20';FileKey='0x10'}) 73 10 $state|Out-Null}catch{$refused=$true}
        if(-not $refused){throw 'ambiguous_header_accepted'}
      }
      $state=Fresh;[void]$state.names.Add('0x0000000000000010');$refused=$false
      try{ConvertTo-HpmPersistentIoRecord (XmlEvent '' @{IrpPtr='0x20';FileKey='0x10';TTID='1';IssuingThreadId='2'}) 73 10 $state|Out-Null}catch{$refused=$true}
      if(-not $refused){throw 'ambiguous_issuer_accepted'}
      foreach($version in @(2,3)) {
        $length=if($version -eq 2){32}else{28};$offset=if($version -eq 2){8}else{24};$keyOffset=if($version -eq 2){24}else{16}
        $bytes=[byte[]]::new($length);[BitConverter]::GetBytes([uint64]32).CopyTo($bytes,0)
        [BitConverter]::GetBytes([uint32]789).CopyTo($bytes,$offset);[BitConverter]::GetBytes([uint64]16).CopyTo($bytes,$keyOffset)
        $xml='<Event><System><Version>'+ $version +'</Version><Execution ProcessID="123" ThreadID="456"/></System><BinaryEventData>'+[Convert]::ToHexString($bytes)+'</BinaryEventData></Event>'
        $state=Fresh;[void]$state.names.Add('0x0000000000000010')
        $record=ConvertTo-HpmPersistentIoRecord $xml 73 10 $state|ConvertFrom-Json
        if($record.association.issuingThreadId -ne 789 -or $record.association.eventProcessId -ne 123){throw 'binary_association_lost'}
      }
    }
  `;
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
