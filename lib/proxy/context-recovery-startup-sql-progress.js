'use strict';

const { nativeReaderPromise } = require('./context-recovery-reader-result');
const CLOCK_SQL = 'UPDATE recovery_header SET envelope=? WHERE singleton=1';

// Passive startup observation only. Authentication, SQL arguments/results and
// transaction control stay with the original database. A reported finish means
// the synchronous call returned successfully; it grants no durable ACK.
function createRecoveryStartupSqlProgress(database, onPhase) {
  let active = false;
  let ended = false;
  let writes = 0;
  let overflow = false;
  let commit = false;
  function report(phase) {
    if (!active) return;
    try {
      const result = onPhase(phase);
      if (nativeReaderPromise(result))
        Promise.prototype.then.call(
          result,
          () => {},
          () => {}
        );
    } catch {
      // Diagnostics cannot change the original SQL result or exception.
    }
  }
  function measured(phase, action, receiver, args) {
    report(phase + '_started');
    const result = Reflect.apply(action, receiver, args);
    report(phase + '_finished');
    return result;
  }
  function statement(target) {
    return new Proxy(target, {
      get(object, name) {
        const value = Reflect.get(object, name, object);
        if (typeof value !== 'function') return value;
        return (...args) => {
          if (name === 'run' && active) {
            if (writes < 4)
              return measured('engine_sql_clock_write_' + ++writes, value, object, args);
            if (!overflow) {
              overflow = true;
              report('engine_sql_clock_write_overflow');
            }
          }
          return Reflect.apply(value, object, args);
        };
      },
      set: (object, name, value) => Reflect.set(object, name, value, object),
    });
  }
  const observed = new Proxy(database, {
    get(object, name) {
      const value = Reflect.get(object, name, object);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (active && name === 'exec' && args[0] === 'COMMIT' && !commit) {
          commit = true;
          return measured('engine_sql_commit', value, object, args);
        }
        const result = Reflect.apply(value, object, args);
        return active &&
          name === 'prepare' &&
          args[0] === CLOCK_SQL &&
          result !== null &&
          (typeof result === 'object' || typeof result === 'function')
          ? statement(result)
          : result;
      };
    },
    set: (object, name, value) => Reflect.set(object, name, value, object),
  });
  return Object.freeze({
    database: observed,
    start() {
      if (!ended) active = true;
    },
    finish() {
      active = false;
      ended = true;
    },
  });
}

module.exports = { createRecoveryStartupSqlProgress };
