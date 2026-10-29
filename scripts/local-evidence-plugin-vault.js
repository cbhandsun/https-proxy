'use strict';

const {
  inspectLocalEvidencePlugin,
  retainLocalEvidencePlugin,
  restoreLocalEvidencePlugin,
} = require('./lib/local-evidence-plugin-vault');

// This command only manages verified package bytes. Native session shutdown and
// installation remain explicit operator steps; no client configuration is read.
try {
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === 'inspect' && args.length === 1) result = inspectLocalEvidencePlugin(args[0]);
  else if (command === 'retain' && args.length === 2)
    result = retainLocalEvidencePlugin(args[0], args[1]);
  else if (command === 'restore' && args.length === 3)
    result = restoreLocalEvidencePlugin(args[0], args[1], args[2]);
  else throw new Error('local_evidence_vault_command_failed');
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write('local_evidence_vault_command_failed\n');
  process.exitCode = 1;
}
