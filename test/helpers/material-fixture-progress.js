'use strict';

const phases = Object.freeze([
  'script_started',
  'helper_loaded',
  'sentinels_hashed',
  'collision_checked',
  'lease_compile_started',
  'lease_compiled',
  'identity_checked',
  'materials_removed',
  'cleanup_finished',
]);
function materialFixturePhase(stderr) {
  if (stderr === undefined || stderr === null || stderr === '') return 'unobserved';
  if (typeof stderr !== 'string' || Buffer.byteLength(stderr) > 8192) return 'invalid';
  let seen = -1;
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.startsWith('n08_material_phase=')) continue;
    const next = phases.indexOf(line.slice('n08_material_phase='.length));
    if (next !== seen + 1 || next < 0) return 'invalid';
    seen = next;
  }
  return seen < 0 ? 'unobserved' : phases[seen];
}
module.exports = { materialFixturePhase };
