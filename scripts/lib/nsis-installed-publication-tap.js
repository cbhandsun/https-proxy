'use strict';

const fail = () => new Error('installed_publication_suite_failed');
const TRANSITIONS = ['prepared', 'sending', 'transport-finished', 'uncertain', 'withdrawn'];
const TITLES = Object.freeze(
  TRANSITIONS.flatMap((transition) =>
    ['commit', 'ack'].flatMap((boundary) => [
      ...[true, false].map(
        (kill) =>
          `native worker publication ${transition}: ${kill ? 'SIGKILL' : 'release control'} inside ${boundary === 'commit' ? 'actual COMMIT lock wait' : 'durable OS anchor before publication ACK'}`
      ),
      `native worker HTTP normal stop drains ${transition} inside ${boundary === 'commit' ? 'actual COMMIT lock wait' : 'durable OS anchor before publication ACK'}`,
    ])
  )
);

function parseInstalledPublicationTap(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1048576) throw fail();
  text = text.replace(/\r\n/g, '\n');
  if (!text.startsWith('TAP version 13\n')) throw fail();
  const lines = text.split(/\r?\n/),
    seen = new Set();
  const totals = new Map([
    ['tests', 30],
    ['suites', 0],
    ['pass', 30],
    ['fail', 0],
    ['cancelled', 0],
    ['skipped', 0],
    ['todo', 0],
  ]);
  for (const line of lines) {
    const total = /^# (tests|suites|pass|fail|cancelled|skipped|todo) /.exec(line);
    if (total && line !== '# ' + total[1] + ' ' + totals.get(total[1])) throw fail();
    if (line.startsWith('1..') && line !== '1..30') throw fail();
    if (line.startsWith('not ok ') || /^# (?:cancelled|skipped|todo) [1-9]/.test(line))
      throw fail();
    const match = /^ok ([1-9][0-9]*) - (.+)$/.exec(line);
    if (!match && line.startsWith('ok ')) throw fail();
    if (!match) continue;
    if (Number(match[1]) !== seen.size + 1 || !TITLES.includes(match[2]) || seen.has(match[2]))
      throw fail();
    seen.add(match[2]);
  }
  for (const line of [
    '1..30',
    '# tests 30',
    '# suites 0',
    '# pass 30',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
  ]) {
    if (lines.filter((value) => value === line).length !== 1) throw fail();
  }
  if (seen.size !== 30 || lines.some((line) => /^ok .*# (?:SKIP|TODO)/.test(line))) throw fail();
  return { tests: 30, passedTests: 30, failedTests: 0, skippedTests: 0 };
}
module.exports = { parseInstalledPublicationTap, PUBLICATION_TITLES: TITLES };
