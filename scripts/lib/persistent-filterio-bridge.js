'use strict';

const contract = require('./persistent-filterio-bridge-contract');
const { createPersistentFilterIoCorrelator } = require('./persistent-filterio-correlator');
const { resolvePersistentFilterIoOwner } = require('./persistent-filterio-owner-scope');
const LIMITS = Object.freeze({ events: 1000000, names: 256, files: 256, irps: 8192, spans: 8192 });

function createPersistentFilterIoBridge(input) {
  let settings, clock;
  try {
    settings = contract.data(input, ['clock', 'ownerScope']);
    clock = contract.clock(settings.clock);
    resolvePersistentFilterIoOwner(settings.ownerScope, '');
  } catch {
    throw contract.fail();
  }
  const names = new Map(),
    files = new Map(),
    generations = new Map();
  const active = new Map(),
    irpGenerations = new Map(),
    models = new Map();
  const rejected = {
    unknownOwner: 0,
    unknownFile: 0,
    unknownName: 0,
    nameMismatch: 0,
    unknownIrp: 0,
    fileReuse: 0,
    irpReuse: 0,
    unsupportedMajor: 0,
  };
  let failed = false,
    finished = false,
    events = 0,
    flushes = 0,
    spans = 0,
    lastTime = 0n;
  function send(model, type, time, fields) {
    model.observe({ type, clock, time, ...fields });
  }
  function invalidate(file, time) {
    if (file) file.invalidated = true;
    if (file?.model) {
      send(file.model, 'file-close', time, {
        fileObject: file.fileObject,
        fileGeneration: file.generation,
      });
      file.model = null;
    }
  }
  function changeName(row) {
    const prior = names.get(row.fileKey);
    if (
      prior &&
      (row.type === 'name-delete' || prior.fixtureTag !== row.fixtureTag || prior.kind !== row.kind)
    ) {
      for (const file of files.values())
        if (file.fileKey === row.fileKey) invalidate(file, row.time);
    }
    if (row.type === 'name-delete' || row.fixtureTag === null) names.delete(row.fileKey);
    else {
      if (!names.has(row.fileKey) && names.size >= LIMITS.names) throw contract.fail();
      names.set(row.fileKey, { fixtureTag: row.fixtureTag, kind: row.kind });
    }
  }
  function create(row) {
    invalidateIrp(row);
    const prior = files.get(row.fileObject);
    if (prior) {
      rejected.fileReuse++;
      invalidate(prior, row.time);
    }
    if (!generations.has(row.fileObject) && generations.size >= LIMITS.files) throw contract.fail();
    const generation = (generations.get(row.fileObject) || 0) + 1;
    generations.set(row.fileObject, generation);
    files.set(row.fileObject, {
      fileObject: row.fileObject,
      generation,
      fixtureTag: row.fixtureTag,
      ownerPid: row.pid,
      kind: row.kind,
      model: null,
      fileKey: null,
    });
  }
  function invalidateIrp(row) {
    const entry = active.get(row.irp);
    if (!entry) return;
    rejected.irpReuse++;
    send(entry.model, 'irp-invalidate', row.time, {
      irp: row.irp,
      irpGeneration: entry.binding.irpGeneration,
    });
  }
  function flush(row) {
    if (++flushes > LIMITS.irps) throw contract.fail();
    const previous = active.get(row.irp);
    if (previous) {
      rejected.irpReuse++;
      send(previous.model, 'irp-begin', row.time, previous.binding);
      return;
    }
    const file = files.get(row.fileObject);
    if (!file || file.invalidated) {
      rejected.unknownFile++;
      return;
    }
    const name = names.get(row.fileKey);
    if (!name) {
      rejected.unknownName++;
      invalidate(file, row.time);
      return;
    }
    if (name.fixtureTag !== file.fixtureTag || name.kind !== file.kind) {
      rejected.nameMismatch++;
      invalidate(file, row.time);
      return;
    }
    // Header PID alone never creates an owner. Only exact Create PID/tag
    // intersection with the independently observed stage channel is admitted.
    const owner = resolvePersistentFilterIoOwner(
      settings.ownerScope,
      name.fixtureTag,
      file.ownerPid
    );
    if (!owner) {
      rejected.unknownOwner++;
      return;
    }
    if (file.fileKey !== null && file.fileKey !== row.fileKey) {
      rejected.nameMismatch++;
      invalidate(file, row.time);
      return;
    }
    const ownerKey = owner.pid + ':' + owner.fixtureTag;
    let model = models.get(ownerKey);
    if (!model) {
      model = createPersistentFilterIoCorrelator({ clock, owned: owner });
      models.set(ownerKey, model);
    }
    if (!file.model) {
      file.model = model;
      file.fileKey = row.fileKey;
      send(model, 'file-open', row.time, {
        fileObject: row.fileObject,
        fileGeneration: file.generation,
        ownerPid: owner.pid,
        fixtureTag: owner.fixtureTag,
        kind: name.kind,
      });
    }
    if (!irpGenerations.has(row.irp) && irpGenerations.size >= LIMITS.irps) throw contract.fail();
    const generation = (irpGenerations.get(row.irp) || 0) + 1;
    irpGenerations.set(row.irp, generation);
    const binding = {
      fileObject: row.fileObject,
      fileGeneration: file.generation,
      irp: row.irp,
      irpGeneration: generation,
      majorFunction: 9,
    };
    send(model, 'irp-begin', row.time, binding);
    active.set(row.irp, { model, binding });
  }
  function operation(row) {
    if (row.type === 'filter-init' && ++spans > LIMITS.spans) throw contract.fail();
    const entry = active.get(row.irp);
    if (!entry) {
      rejected.unknownIrp++;
      return;
    }
    if (row.type === 'end') {
      send(entry.model, 'irp-end', row.time, {
        irp: row.irp,
        irpGeneration: entry.binding.irpGeneration,
        ntStatus: row.ntStatus,
      });
      active.delete(row.irp);
      return;
    }
    if (row.majorFunction !== 9) rejected.unsupportedMajor++;
    const phase = row.opcode % 2 === 0 ? 'pre' : 'post';
    send(entry.model, row.type, row.time, {
      ...entry.binding,
      fileObject: row.fileObject,
      majorFunction: row.majorFunction,
      routine: row.routine,
      fileContext: row.fileContext,
      callbackData: row.callbackData,
      phase,
      ...(row.type === 'filter-complete' ? { initialTime: row.initialTime } : {}),
      ...(row.type === 'filter-failure' ? { status: row.status } : {}),
    });
  }
  function summary(final) {
    if (failed) throw contract.fail();
    // Revalidate source even when no matching ETW record arrived.
    resolvePersistentFilterIoOwner(settings.ownerScope, '');
    const rows = ['database', 'journal'].flatMap((kind) =>
      ['pre', 'post'].map((phase) => ({ kind, phase, count: 0, maxObservedSpanUs: 0 }))
    );
    const mismatches = {};
    for (const model of models.values()) {
      const value = final ? model.finish() : model.snapshot();
      for (const item of value.rows) {
        const row = rows.find((x) => x.kind === item.kind && x.phase === item.phase);
        row.count += item.count;
        row.maxObservedSpanUs = Math.max(row.maxObservedSpanUs, item.maxObservedSpanUs);
      }
      for (const [name, count] of Object.entries(value.mismatches))
        mismatches[name] = (mismatches[name] || 0) + count;
    }
    return {
      schemaVersion: 1,
      scope: 'fixture_filterio_candidate_spans',
      finished,
      events,
      rows,
      rejected: { ...rejected },
      mismatches,
      nativeCaptureQualified: false,
      filterAttributionQualified: false,
      processCreationVerified: false,
      physicalFileIdentityVerified: false,
      realModelRequests: 0,
    };
  }
  return Object.freeze({
    observe(raw) {
      try {
        if (failed || finished || ++events > LIMITS.events) throw contract.fail();
        const row = contract.event(raw),
          time = contract.tick(row.time);
        if (time < lastTime) throw contract.fail();
        lastTime = time;
        if (row.type === 'name' || row.type === 'name-delete') changeName(row);
        else if (row.type === 'create') create(row);
        else if (row.type === 'close') {
          invalidateIrp(row);
          const file = files.get(row.fileObject);
          if (!file) rejected.unknownFile++;
          else {
            invalidate(file, row.time);
            files.delete(row.fileObject);
          }
        } else if (row.type === 'invalidate-irp') invalidateIrp(row);
        else if (row.type === 'flush') flush(row);
        else operation(row);
      } catch {
        failed = true;
        throw contract.fail();
      }
    },
    snapshot() {
      try {
        return summary(false);
      } catch {
        failed = true;
        throw contract.fail();
      }
    },
    finish() {
      try {
        finished = true;
        return summary(true);
      } catch {
        failed = true;
        throw contract.fail();
      }
    },
  });
}

module.exports = {
  createPersistentFilterIoBridge,
  LIMITS,
  parsePersistentFilterIoRawLine: contract.parsePersistentFilterIoRawLine,
};
