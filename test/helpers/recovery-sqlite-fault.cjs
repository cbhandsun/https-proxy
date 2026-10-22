'use strict';

// Keep real SQLite transactions and statements. Faults fire only after a real
// statement has completed, so rollback tests cannot pass via schema rejection.
function recoverySqliteFaults(database, afterWrite) {
  return {
    exec: (sql) => database.exec(sql),
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args),
        run(...args) {
          const result = statement.run(...args);
          afterWrite(sql, args, result);
          return result;
        },
      };
    },
  };
}

module.exports = { recoverySqliteFaults };
