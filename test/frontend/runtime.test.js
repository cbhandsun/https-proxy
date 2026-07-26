'use strict';

const assert = require('node:assert/strict');

(async () => {
  const createdElements = [];
  global.window = {};
  global.document = {
    documentElement: { dataset: {} },
    createElement(tagName) {
      const element = { tagName, textContent: '', value: '' };
      createdElements.push(element);
      return element;
    },
  };
  global.requestAnimationFrame = (callback) => callback();

  const dom = await import('../../tauri-ui/src/app/runtime/dom.js');
  const performanceRuntime = await import('../../tauri-ui/src/app/runtime/performance.js');
  const { createSharedAppState } = await import('../../tauri-ui/src/app/runtime/app-state.js');

  const firstState = createSharedAppState();
  const secondState = createSharedAppState();
  assert.notEqual(firstState, secondState);
  assert.deepEqual(firstState.monitorEvents, []);
  firstState.lastStatusRefresh = 12;
  assert.equal(firstState.lastStatusRefresh, 12);
  assert.equal(Object.isSealed(firstState), true);
  assert.throws(() => {
    firstState.unexpected = true;
  }, /not extensible/);

  assert.equal(dom.escapeHtml('<tag attr="x">&'), '&lt;tag attr=&quot;x&quot;&gt;&amp;');
  assert.equal(dom.escapeAttr("'"), '&#39;');
  const target = { textContent: 'old' };
  dom.clearElement(target);
  assert.equal(target.textContent, '');
  assert.throws(() => dom.appendOption(null, 'x'), /appendChild/);
  const options = [];
  const option = dom.appendOption({ appendChild: (value) => options.push(value) }, 7, null);
  assert.equal(option.value, '7');
  assert.equal(option.textContent, '');
  assert.deepEqual(options, [option]);
  assert.throws(() => dom.debounce(null), /must be a function/);

  const taskErrors = [];
  assert.throws(() => performanceRuntime.initPerformanceRuntime(null), /must be an object/);
  assert.throws(
    () => performanceRuntime.initPerformanceRuntime({ onTaskError: true }),
    /must be a function/
  );
  performanceRuntime.initPerformanceRuntime({
    onTaskError: (label, error) => taskErrors.push({ label, error }),
  });
  assert.ok(global.window.__hpmPerf);
  assert.throws(() => performanceRuntime.recordPerf('', 1), /non-empty string/);
  performanceRuntime.recordPerf('test', Number.NaN, []);
  assert.equal(global.window.__hpmPerf.report().at(-1).duration, 0);
  assert.equal(await performanceRuntime.perfTrack('async-test', async () => 42), 42);
  assert.throws(
    () => performanceRuntime.promiseWithTimeout(Promise.resolve(), -1, 'timeout'),
    /non-negative/
  );
  await assert.rejects(
    performanceRuntime.promiseWithTimeout(new Promise(() => {}), 1, 'expected timeout'),
    /expected timeout/
  );
  assert.throws(
    () => performanceRuntime.scheduleStartupTask('invalid', null),
    /must be a function/
  );
  performanceRuntime.scheduleStartupTask(
    'failure',
    () => {
      throw new Error('synthetic');
    },
    { eager: true, delay: 0 }
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(taskErrors.length, 1);
  assert.equal(taskErrors[0].label, 'failure');
  assert.equal(taskErrors[0].error.message, 'synthetic');

  console.log('[runtime.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
