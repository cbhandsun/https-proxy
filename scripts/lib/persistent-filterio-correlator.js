'use strict';

const contract = require('./persistent-filterio-contract');

// Pure scalar evidence only. traceId is a controller-issued nonce, never an ETL
// content hash. fixtureTag is an adapter-verified opaque identity, not a path.
function createPersistentFilterIoCorrelator(input) {
  let settings;
  try {
    settings = contract.options(input);
  } catch {
    throw contract.fail();
  }
  const files = new Map(),
    fileGenerations = new Map(),
    irps = new Map(),
    active = new Map();
  const irpGenerations = new Map();
  const mismatches = Object.fromEntries(contract.MISMATCHES.map((name) => [name, 0]));
  let failed = false,
    finished = false,
    events = 0,
    candidates = 0;
  const mismatch = (name, row) => {
    mismatches[name]++;
    if (row) row.tainted = true;
  };
  const irpKey = (value) => `${value.irp}:${value.irpGeneration}`;
  const fullKey = (value) =>
    JSON.stringify([
      value.routine,
      value.fileObject,
      value.fileGeneration,
      value.fileContext,
      value.irp,
      value.irpGeneration,
      value.callbackData,
      value.majorFunction,
      value.phase,
    ]);
  function invalidateFile(file) {
    if (file.invalidated) return;
    file.invalidated = true;
    for (const row of file.rows) mismatch('fileLifecycle', row);
  }
  function open(value) {
    if (value.ownerPid !== settings.owned.pid || value.fixtureTag !== settings.owned.fixtureTag) {
      const prior = files.get(value.fileObject);
      if (prior) invalidateFile(prior);
      mismatch('unownedFile');
      return;
    }
    const current = files.get(value.fileObject);
    if (current) {
      invalidateFile(current);
      mismatch('fileLifecycle');
      return;
    }
    const prior = fileGenerations.get(value.fileObject);
    if (prior !== undefined && value.fileGeneration <= prior) {
      mismatch('generationMismatch');
      return;
    }
    if (prior === undefined && fileGenerations.size >= contract.LIMITS.files) throw contract.fail();
    fileGenerations.set(value.fileObject, value.fileGeneration);
    files.set(value.fileObject, { ...value, rows: new Set() });
  }
  function close(value) {
    const file = files.get(value.fileObject);
    if (!file) {
      mismatch('unknownFile');
      return;
    }
    if (file.fileGeneration !== value.fileGeneration) {
      mismatch('generationMismatch');
      return;
    }
    invalidateFile(file);
    if (value.time < file.time) mismatch('outOfOrder');
    files.delete(value.fileObject);
  }
  function begin(value) {
    const prior = active.get(value.irp);
    if (prior) {
      mismatch('irpLifecycle', prior);
      return;
    }
    const key = irpKey(value);
    if (irps.has(key)) {
      mismatch('generationMismatch', irps.get(key));
      return;
    }
    const file = files.get(value.fileObject);
    if (!file) {
      mismatch('unknownFile');
      return;
    }
    if (file.fileGeneration !== value.fileGeneration) {
      mismatch('generationMismatch');
      return;
    }
    if (file.invalidated) {
      mismatch('fileLifecycle');
      return;
    }
    // This first collector admits only the actual FileIO Flush operation (73).
    if (value.majorFunction !== 9) {
      mismatch('keyMismatch');
      return;
    }
    if (value.time < file.time) {
      mismatch('outOfOrder');
      return;
    }
    const priorGeneration = irpGenerations.get(value.irp);
    if (priorGeneration !== undefined && priorGeneration >= value.irpGeneration) {
      mismatch('generationMismatch');
      return;
    }
    if (irps.size + candidates >= contract.LIMITS.irps) throw contract.fail();
    const row = {
      ...value,
      kind: file.kind,
      fileEpoch: file,
      tainted: false,
      ended: false,
      latest: value.time,
      pending: new Map(),
      spans: [],
      last: new Map(),
    };
    irps.set(key, row);
    active.set(value.irp, row);
    file.rows.add(row);
    irpGenerations.set(value.irp, value.irpGeneration);
  }
  function find(value) {
    const row = irps.get(irpKey(value));
    if (!row) {
      mismatch('unknownIrp');
      return null;
    }
    if (row.ended || active.get(value.irp) !== row) {
      mismatch('irpLifecycle', row);
      return null;
    }
    if (value.time < row.time) {
      mismatch('outOfOrder', row);
      return null;
    }
    if (
      !['irp-end', 'irp-invalidate'].includes(value.type) &&
      (row.fileObject !== value.fileObject ||
        row.fileGeneration !== value.fileGeneration ||
        row.majorFunction !== value.majorFunction)
    ) {
      mismatch('keyMismatch', row);
      return null;
    }
    return row;
  }
  function end(value) {
    const row = find(value);
    if (!row) return;
    if (value.ntStatus !== 0) mismatch('operationFailure', row);
    const file = files.get(row.fileObject);
    if (!file || file.fileGeneration !== row.fileGeneration) mismatch('fileLifecycle', row);
    if (value.time < row.latest) mismatch('outOfOrder', row);
    if (row.pending.size) {
      mismatches.missingCompletion += row.pending.size;
      row.tainted = true;
    }
    row.pending.clear();
    row.ended = true;
    active.delete(value.irp);
    row.fileEpoch.rows.delete(row);
  }
  function invalidateIrp(value) {
    const row = find(value);
    if (!row) return;
    mismatch('irpLifecycle', row);
    row.latest = value.time > row.latest ? value.time : row.latest;
    // Keep the real epoch active but tainted. No status/end is fabricated;
    // a later OpEnd from the pointer's new operation cannot publish its spans.
  }
  function filter(value) {
    const row = find(value);
    if (!row) return;
    const file = files.get(value.fileObject);
    if (!file || file.fileGeneration !== value.fileGeneration) {
      mismatch('fileLifecycle', row);
      return;
    }
    row.latest = value.time > row.latest ? value.time : row.latest;
    if (value.type === 'filter-failure') {
      mismatch('filterFailure', row);
      return;
    }
    const key = fullKey(value);
    if (value.type === 'filter-init') {
      if (row.pending.has(key)) {
        mismatch('duplicateInit', row);
        return;
      }
      if (row.last.has(key) && value.time <= row.last.get(key)) {
        mismatch('outOfOrder', row);
        return;
      }
      if (++candidates + irps.size > contract.LIMITS.spans) throw contract.fail();
      row.pending.set(key, value);
      return;
    }
    const start = row.pending.get(key);
    if (!start) {
      mismatch('missingInit', row);
      return;
    }
    row.pending.delete(key);
    row.last.set(key, value.time);
    if (value.time < start.time) {
      mismatch('outOfOrder', row);
      return;
    }
    if (value.initialTime !== start.time) {
      mismatch('initialTimeMismatch', row);
      return;
    }
    row.spans.push({ phase: value.phase, ticks: value.time - start.time });
  }
  function snapshot() {
    if (failed) throw contract.fail();
    const rows = ['database', 'journal'].flatMap((kind) =>
      ['pre', 'post'].map((phase) => ({ kind, phase, count: 0, maxObservedSpanUs: 0 }))
    );
    for (const irp of irps.values()) {
      // Candidates stay private until the real matching IRP end. Any ambiguity,
      // close before end or missing end discards the entire epoch's spans.
      if (!irp.ended || irp.tainted) continue;
      for (const span of irp.spans) {
        const micros = (span.ticks * 1000000n) / settings.clock.frequency;
        if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
          failed = true;
          throw contract.fail();
        }
        const row = rows.find((item) => item.kind === irp.kind && item.phase === span.phase);
        row.count++;
        row.maxObservedSpanUs = Math.max(row.maxObservedSpanUs, Number(micros));
      }
    }
    return {
      schemaVersion: 1,
      scope: 'owned_flush_filterio_observed_spans',
      filterAttributionQualified: false,
      nativeCaptureQualified: false,
      realModelRequests: 0,
      finished,
      rows,
      mismatches: { ...mismatches },
    };
  }
  return Object.freeze({
    observe(inputEvent) {
      try {
        if (failed || finished || ++events > contract.LIMITS.events) throw contract.fail();
        const value = contract.event(inputEvent, settings.clock);
        if (value.type === 'file-open') open(value);
        else if (value.type === 'file-close') close(value);
        else if (value.type === 'irp-begin') begin(value);
        else if (value.type === 'irp-end') end(value);
        else if (value.type === 'irp-invalidate') invalidateIrp(value);
        else filter(value);
      } catch {
        failed = true;
        throw contract.fail();
      }
    },
    snapshot,
    finish() {
      if (failed) throw contract.fail();
      if (!finished) {
        for (const row of active.values()) {
          mismatch('unfinishedIrp', row);
          mismatches.missingCompletion += row.pending.size;
          row.pending.clear();
        }
        finished = true;
      }
      return snapshot();
    },
  });
}

module.exports = { createPersistentFilterIoCorrelator };
