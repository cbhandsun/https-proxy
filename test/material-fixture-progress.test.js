'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { materialFixturePhase } = require('./helpers/material-fixture-progress');

test('material progress reports only the last ordered fixed stage, never stderr content', () => {
  let stderr = 'PRIVATE_NATIVE_WARNING\n';
  for (const phase of [
    'script_started',
    'helper_loaded',
    'sentinels_hashed',
    'collision_checked',
    'lease_compile_started',
    'lease_compiled',
    'identity_checked',
    'materials_removed',
    'cleanup_finished',
  ]) {
    stderr += 'n08_material_phase=' + phase + '\r\n';
    assert.equal(materialFixturePhase(stderr), phase);
  }
  assert.equal(materialFixturePhase('PRIVATE_NATIVE_WARNING'), 'unobserved');
  assert.equal(materialFixturePhase('n08_material_phase=PRIVATE'), 'invalid');
});

test('material progress rejects missing, repeated, out-of-order and oversized phase records', () => {
  for (const value of [null, undefined, ''])
    assert.equal(materialFixturePhase(value), 'unobserved');
  for (const value of [
    [],
    {},
    Buffer.from('PRIVATE'),
    'x'.repeat(8193),
    'n08_material_phase=helper_loaded\n',
    'n08_material_phase=script_started\nn08_material_phase=script_started\n',
    'n08_material_phase=script_started\nn08_material_phase=lease_compiled\n',
  ])
    assert.equal(materialFixturePhase(value), 'invalid');
});
