'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { types } = require('node:util');
const fail = () => new Error('independent_acl_readback_failed');

// This verifier is independent of the product's Rust DACL setter/readback. Both
// shells inspect the same Windows descriptors and require the original rules.
const script = `$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);
  $data=[Console]::In.ReadToEnd()|ConvertFrom-Json;
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
  $expected=@($sid,'S-1-5-18','S-1-5-32-544')|Sort-Object -Unique;
  foreach($item in $data){
    if($PSVersionTable.PSVersion.Major -ge 6){
      $entry=Get-Item -LiteralPath $item.path -Force;
      if([bool]$entry.PSIsContainer -ne ($item.kind -eq 'directory')){exit 1};
      $acl=Get-Acl -LiteralPath $item.path
    }else{$acl=if($item.kind -eq 'directory'){
      [IO.Directory]::GetAccessControl($item.path)
    }else{[IO.File]::GetAccessControl($item.path)}};
    if(-not $acl.AreAccessRulesProtected){exit 1};
    $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));
    if($rules.Count -ne $expected.Count){exit 1};
    $found=@();foreach($rule in $rules){
      $found+=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;
      if($rule.AccessControlType -ne 'Allow' -or [int]$rule.FileSystemRights -ne 2032127 -or $rule.IsInherited){exit 1};
      $flags=if($item.kind -eq 'directory'){3}else{0};
      if([int]$rule.InheritanceFlags -ne $flags){exit 1}
    };if(Compare-Object ($found|Sort-Object -Unique) $expected){exit 1}
  };[Console]::Out.Write('verified')`;

function data(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const slot = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !Object.hasOwn(slot, 'value')) throw fail();
    result[key] = slot.value;
  }
  return result;
}
function absolute(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    path.win32.isAbsolute(value) &&
    !/^[\\/]{2}/.test(value) &&
    !/[\0\r\n]/.test(value)
  );
}
function verifyIndependentAcl(items, options = {}) {
  try {
    options = data(options);
    if (
      Object.keys(options).some(
        (key) => !['execute', 'exists', 'systemRoot', 'programFiles'].includes(key)
      )
    )
      throw fail();
    const execute = Object.hasOwn(options, 'execute') ? options.execute : execFileSync;
    const exists = Object.hasOwn(options, 'exists') ? options.exists : fs.existsSync;
    for (const fn of [execute, exists])
      if (typeof fn !== 'function' || types.isProxy(fn)) throw fail();
    const systemRoot = options.systemRoot ?? process.env.SystemRoot;
    const programFiles = options.programFiles ?? process.env.ProgramFiles;
    if (!absolute(systemRoot) || !absolute(programFiles)) throw fail();
    if (
      !Array.isArray(items) ||
      types.isProxy(items) ||
      items.length !== 4 ||
      Reflect.ownKeys(items).length !== 5
    )
      throw fail();
    const normalized = [];
    for (let index = 0; index < 4; index++) {
      const slot = Object.getOwnPropertyDescriptor(items, String(index));
      if (!slot || !Object.hasOwn(slot, 'value')) throw fail();
      const item = data(slot.value);
      if (
        Object.keys(item).sort().join(',') !== 'kind,path' ||
        !absolute(item.path) ||
        !['file', 'directory'].includes(item.kind)
      )
        throw fail();
      normalized.push(item);
    }
    const modern = path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
    const available = exists(modern);
    if (typeof available !== 'boolean') throw fail();
    const executable = available
      ? modern
      : path.win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const result = execute(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: JSON.stringify(normalized),
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result !== 'verified') throw fail();
    return result;
  } catch {
    throw fail();
  }
}
module.exports = { verifyIndependentAcl };
