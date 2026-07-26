'use strict';

const fs = require('fs');
const path = require('path');
const { validateCiGovernance, validateReleaseWorkflow } = require('../lib/ci-governance');

const repoRoot = path.resolve(__dirname, '..');
const workflowDir = path.join(repoRoot, '.github', 'workflows');
const workflowFiles = fs
  .readdirSync(workflowDir)
  .filter((fileName) => /\.ya?ml$/i.test(fileName))
  .sort();
const workflows = Object.fromEntries(
  workflowFiles.map((fileName) => [
    fileName,
    fs.readFileSync(path.join(workflowDir, fileName), 'utf8'),
  ])
);
const workflow = Object.values(workflows).join('\n');
const dependabot = fs.readFileSync(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
const errors = [
  ...validateCiGovernance(workflow, dependabot),
  ...validateReleaseWorkflow(workflows['release.yml']),
];

if (errors.length > 0) {
  for (const error of errors) console.error(`[ci-governance] ${error}`);
  process.exit(1);
}
console.log('[ci-governance] ok');
