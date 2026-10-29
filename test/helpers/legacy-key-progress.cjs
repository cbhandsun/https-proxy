'use strict';
const { types } = require('node:util');
const PHASES = [
  'script_started',
  'assembly_started',
  'assembly_finished',
  'input_started',
  'input_finished',
  'dpapi_started',
  'dpapi_finished',
  'roundtrip_started',
  'roundtrip_finished',
  'output_started',
  'script_completed',
];
const marker = (phase) => `[Console]::Error.WriteLine('hpm_legacy_key_phase=${phase}');`;
const invalid = () => new Error('legacy_key_probe_invalid');
// Test-only observation: the original fixed script is byte-identical after
// removing these fixed stderr writes. Requests and transport options stay intact.
function observeLegacyKeyArguments(input) {
  if (
    types.isProxy(input) ||
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    Reflect.ownKeys(input).length !== 6 ||
    !Reflect.ownKeys(input).every(
      (key, index) => key === ['0', '1', '2', '3', '4', 'length'][index]
    )
  )
    throw invalid();
  const args = [];
  for (let i = 0; i < 5; i++) {
    const slot = Object.getOwnPropertyDescriptor(input, String(i));
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value') || typeof slot.value !== 'string')
      throw invalid();
    args.push(slot.value);
  }
  if (
    args.slice(0, 4).join(',') !== '-NoLogo,-NoProfile,-NonInteractive,-Command' ||
    args[4].length > 10000 ||
    args[4].includes('hpm_legacy_key_phase=')
  )
    throw invalid();
  let script = args[4];
  const wrap = (line, before, after) => {
    if (script.split(line).length !== 2) throw invalid();
    script = script.replace(
      line,
      (before ? marker(before) : '') + line + (after ? marker(after) : '')
    );
  };
  wrap('try {', null, 'script_started');
  wrap(
    "[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');",
    'assembly_started',
    'assembly_finished'
  );
  wrap('$keyRequestText=[Console]::In.ReadToEnd();', 'input_started', 'input_finished');
  wrap(
    "$keyResult=[Security.Cryptography.ProtectedData]::Protect($keyBytes,$keyEntropy,'CurrentUser');",
    'dpapi_started',
    'dpapi_finished'
  );
  wrap(
    "$keyResult=[Security.Cryptography.ProtectedData]::Unprotect($keyBytes,$keyEntropy,'CurrentUser');",
    'dpapi_started',
    'dpapi_finished'
  );
  wrap(
    "$keyCheck=[Security.Cryptography.ProtectedData]::Unprotect($keyResult,$keyEntropy,'CurrentUser');",
    'roundtrip_started',
    'roundtrip_finished'
  );
  wrap(
    '[Console]::Out.Write(\'{"ok":true,"value":"\'+[Convert]::ToBase64String($keyResult)+\'"}\');',
    'output_started',
    'script_completed'
  );
  return [...args.slice(0, 4), script];
}
function legacyKeyPhase(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2048) return 'invalid';
  let previous = -1,
    last = 'unobserved';
  const lines = text.split(/\r?\n/);
  for (const [position, line] of lines.entries()) {
    if (!line.startsWith('hpm_legacy_key_phase=')) continue;
    if (position === lines.length - 1 && !text.endsWith('\n')) return 'invalid';
    const phase = line.slice('hpm_legacy_key_phase='.length),
      index = PHASES.indexOf(phase);
    const next = previous === 6 && index === 9 ? 9 : previous + 1;
    if (index !== next || index < 0) return 'invalid';
    previous = index;
    last = phase;
  }
  return last;
}
function legacyKeyErrorPhase(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return 'unobserved';
  const slot = Object.getOwnPropertyDescriptor(error, 'stderr');
  return slot && Object.hasOwn(slot, 'value') ? legacyKeyPhase(slot.value) : 'unobserved';
}
module.exports = { observeLegacyKeyArguments, legacyKeyPhase, legacyKeyErrorPhase };
