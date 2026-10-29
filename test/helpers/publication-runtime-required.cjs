'use strict';
const { selectPublicationRuntime } = require('./publication-runtime.cjs');
if (!selectPublicationRuntime()) throw new Error('installed_publication_runtime_rejected');
