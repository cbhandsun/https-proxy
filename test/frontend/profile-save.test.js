'use strict';

const assert = require('node:assert/strict');
const { structuredClone } = globalThis;

(async () => {
  const { buildProfileSaveCandidate } =
    await import('../../tauri-ui/src/app/models/profile-save.js');

  const original = {
    activeProfile: 'existing',
    profiles: [
      {
        id: 'existing',
        name: 'Existing',
        targetUrl: 'https://example.com/v1',
        protocol: 'openai',
        apiKey: 'kept',
        allowInsecureHttpUpstream: false,
      },
    ],
    modelRoutes: [],
  };
  const originalSnapshot = structuredClone(original);
  const added = buildProfileSaveCandidate(original, 'profile-temporary', {
    id: ' profile-new ',
    name: ' New upstream ',
    targetUrl: ' http://host:80/v1 ',
    protocol: ' openai ',
    apiKey: ' secret ',
    allowInsecureHttpUpstream: false,
  });

  assert.deepEqual(original, originalSnapshot, 'building a candidate must not mutate live config');
  assert.notEqual(added.configuration, original);
  assert.notEqual(added.configuration.profiles, original.profiles);
  assert.equal(added.selectedId, 'profile-new');
  assert.deepEqual(added.configuration.profiles[1], {
    id: 'profile-new',
    name: 'New upstream',
    targetUrl: 'http://host:80/v1',
    protocol: 'openai',
    apiKey: 'secret',
    allowInsecureHttpUpstream: false,
  });

  const replaced = buildProfileSaveCandidate(original, 'existing', {
    id: 'renamed',
    name: '',
    targetUrl: 'https://new.example/v1',
    protocol: '',
    apiKey: '',
    allowInsecureHttpUpstream: true,
  });
  assert.equal(replaced.configuration.profiles.length, 1);
  assert.equal(replaced.configuration.profiles[0].id, 'renamed');
  assert.equal(replaced.selectedId, 'renamed');
  assert.deepEqual(original, originalSnapshot, 'replacement candidates must remain copy-on-write');

  for (const invalidConfiguration of [null, [], {}, { profiles: null }]) {
    assert.throws(
      () => buildProfileSaveCandidate(invalidConfiguration, '', {}),
      /configuration|profile/
    );
  }
  for (const invalidProfile of [null, [], '', { id: '', targetUrl: 'https://example.com' }]) {
    assert.throws(
      () => buildProfileSaveCandidate(original, '', invalidProfile),
      /profile|configuration/
    );
  }
  assert.throws(
    () =>
      buildProfileSaveCandidate(original, '', {
        id: 'x'.repeat(201),
        name: '',
        targetUrl: 'https://example.com',
        protocol: 'openai',
        apiKey: '',
      }),
    /too long/
  );
  assert.throws(
    () =>
      buildProfileSaveCandidate(original, '', {
        id: 'valid',
        name: '',
        targetUrl: 'x'.repeat(2049),
        protocol: 'openai',
        apiKey: '',
      }),
    /too long/
  );
  assert.throws(
    () =>
      buildProfileSaveCandidate(original, '', {
        id: 'valid',
        name: '',
        targetUrl: 'https://example.com',
        protocol: 'openai',
        apiKey: 'x'.repeat(4097),
      }),
    /too long/
  );

  console.log('[profile-save.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
