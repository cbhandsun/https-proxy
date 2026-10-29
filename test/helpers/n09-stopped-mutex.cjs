'use strict';
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.argv[2], { allowExtension: false });
database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
process.send({ ready: true });
setInterval(() => {}, 1000);
