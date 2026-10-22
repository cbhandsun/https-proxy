'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createIsolatedTestEnv } = require('../../lib/test-runtime');
const { resolveTestPython, parsePythonTestCount } = require('../../lib/test-python-runtime');

// This entry is a child fixture, not a separately discovered unit test.
assert.equal(process.env.NODE_TEST_CONTEXT, undefined);
assert.equal(process.env.NODE_ENV, 'test');
const python = resolveTestPython(process.env);
const nested = createIsolatedTestEnv(
  process.env,
  path.join(path.dirname(process.env.PROXY_RUNTIME_DIR), 'nested-python')
);
assert.equal(resolveTestPython(nested), python);
assert.notEqual(nested.HOME, process.env.HOME);
assert.equal(nested.NODE_TEST_CONTEXT, undefined);
nested.HPM_PYTHON_FIXTURE_EXPECTED_HOME = nested.HOME;
const program = [
  'import os, unittest',
  'class RuntimeFixture(unittest.TestCase):',
  '    def test_real_python_executes_fixed_input(self):',
  '        self.assertEqual(sum([2, 3, 5]), 10)',
  '        self.assertEqual("runtime".upper(), "RUNTIME")',
  '    def test_nested_isolated_environment(self):',
  '        self.assertEqual(os.environ["NODE_ENV"], "test")',
  '        self.assertEqual(os.environ["HOME"], os.environ["HPM_PYTHON_FIXTURE_EXPECTED_HOME"])',
  '        self.assertEqual(os.environ["USERPROFILE"], os.environ["HOME"])',
  '        self.assertNotIn("NODE_TEST_CONTEXT", os.environ)',
  'unittest.main()',
].join('\n');
const result = spawnSync(python, ['-I', '-B', '-c', program], {
  env: nested,
  encoding: 'utf8',
  timeout: 20000,
  windowsHide: true,
});
assert.equal(result.error, undefined);
assert.equal(result.status, 0, 'Generic isolated Python tests failed');
const pythonTests = parsePythonTestCount(result.stderr);
assert.ok(pythonTests > 0, 'Python must report actual tests');
process.stdout.write(JSON.stringify({ pythonTests }) + '\n');
