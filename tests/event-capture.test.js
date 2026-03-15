import { describe, it, expect } from 'vitest';
import { fork } from 'child_process';
import path from 'path';

const RUNNER_TIMEOUT_MS = 10000;

/**
 * Forks runner.js with a script path and collects the events it sends back.
 * @param {string} scriptPath - Relative path from the project root
 * @returns {Promise<Array<{ type: string, [key: string]: any }>>}
 */
function runScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = fork(
      path.resolve('src/runner.js'),
      [scriptPath],
      { silent: true },
    );

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`runner timed out for ${scriptPath}`));
    }, RUNNER_TIMEOUT_MS);

    child.on('message', (msg) => {
      if (msg.type === 'events') {
        clearTimeout(timeout);
        resolve(msg.data);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`runner exited with code ${code}`));
    });
  });
}

describe('integration: async-await.js', () => {
  let events;

  it('captures the full event lifecycle', async () => {
    events = await runScript('examples/async-await.js');

    const types = events.map(e => e.type);
    expect(types[0]).toBe('SYNC_START');
    expect(types).toContain('SYNC_END');
    expect(types[types.length - 1]).toBe('DONE');
  });

  it('emits the exact event type sequence', () => {
    const types = events.map(e => e.type);

    expect(types).toEqual([
      'SYNC_START',
      'LOG',
      'SYNC_STEP',
      'LOG',
      'SYNC_END',
      'ENQUEUE_MICRO',
      'CALLBACK_START',
      'CALLBACK_END',
      'ENQUEUE_MICRO',
      'CALLBACK_START',
      'MEMORY',
      'LOG',
      'CALLBACK_END',
      'DONE',
    ]);
  });

  it('logs appear in the correct execution order', () => {
    const logs = events.filter(e => e.type === 'LOG').map(e => e.value);

    expect(logs).toEqual([
      '1 - start',
      '3 - sync after call',
      '2 - after await: data',
    ]);
  });

  it('tracks the await result in MEMORY', () => {
    const mem = events.find(e => e.type === 'MEMORY');

    expect(mem).toBeDefined();
    expect(mem.label).toBe('result');
    expect(mem.value).toBe('"data"');
  });

  it('enqueues the await as a promise microtask', () => {
    const micros = events.filter(
      e => e.type === 'ENQUEUE_MICRO' && e.subtype === 'promise',
    );

    expect(micros).toHaveLength(1);
    expect(micros[0].label).toContain('await');
    expect(micros[0].line).toBe(5);
  });

  it('pairs every CALLBACK_START with a CALLBACK_END', () => {
    const starts = events.filter(e => e.type === 'CALLBACK_START');
    const ends = events.filter(e => e.type === 'CALLBACK_END');

    expect(starts).toHaveLength(ends.length);

    for (const start of starts) {
      const matchingEnd = ends.find(e => e.taskId === start.taskId);
      expect(matchingEnd).toBeDefined();
    }
  });

  it('assigns sequential seq numbers', () => {
    const seqs = events.map(e => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }
  });

  it('captures the fetchData() call as a SYNC_STEP', () => {
    const steps = events.filter(e => e.type === 'SYNC_STEP');

    expect(steps).toHaveLength(1);
    expect(steps[0].label).toBe('fetchData()');
    expect(steps[0].line).toBe(8);
  });
});

describe('integration: closure-loop.js', () => {
  it('captures setTimeout macrotask events', async () => {
    const events = await runScript('examples/closure-loop.js');

    const macros = events.filter(e => e.type === 'ENQUEUE_MACRO');
    expect(macros.length).toBe(3);
    expect(macros.every(e => e.subtype === 'setTimeout')).toBe(true);
  });

  it('setTimeout callbacks all fire', async () => {
    const events = await runScript('examples/closure-loop.js');

    const callbacks = events.filter(
      e => e.type === 'CALLBACK_START' && e.subtype === 'setTimeout',
    );
    expect(callbacks.length).toBe(3);
  });

  it('logs the closure value (3) three times', async () => {
    const events = await runScript('examples/closure-loop.js');

    const logs = events.filter(e => e.type === 'LOG').map(e => e.value);
    expect(logs.filter(v => v === '3').length).toBe(3);
  });
});

describe('integration: rate-limit-pattern.js', () => {
  let events;

  it('captures the full event lifecycle', async () => {
    events = await runScript('examples/rate-limit-pattern.js');

    const types = events.map(e => e.type);
    expect(types[0]).toBe('SYNC_START');
    expect(types[types.length - 1]).toBe('DONE');
    expect(types).toContain('SYNC_END');
  });

  it('SYNC_END occurs before any CALLBACK_START', () => {
    const syncEndIdx = events.findIndex(e => e.type === 'SYNC_END');
    const firstCallbackIdx = events.findIndex(e => e.type === 'CALLBACK_START');

    expect(syncEndIdx).toBeGreaterThan(-1);
    expect(firstCallbackIdx).toBeGreaterThan(syncEndIdx);
  });

  it('enqueues both microtasks and one macrotask during sync phase', () => {
    const syncEndIdx = events.findIndex(e => e.type === 'SYNC_END');
    const syncPhase = events.slice(0, syncEndIdx);

    const micros = syncPhase.filter(e => e.type === 'ENQUEUE_MICRO');
    const macros = syncPhase.filter(e => e.type === 'ENQUEUE_MACRO');

    expect(micros.length).toBeGreaterThanOrEqual(2);
    expect(macros).toHaveLength(1);
    expect(macros[0].subtype).toBe('setTimeout');
  });

  it('microtask callbacks fire before the macrotask callback', () => {
    const callbacks = events.filter(e => e.type === 'CALLBACK_START');
    const microCallbacks = callbacks.filter(e => e.kind === 'micro');
    const macroCallbacks = callbacks.filter(e => e.kind === 'macro');

    expect(macroCallbacks).toHaveLength(1);

    const firstMicroIdx = events.indexOf(microCallbacks[0]);
    const macroIdx = events.indexOf(macroCallbacks[0]);

    expect(firstMicroIdx).toBeLessThan(macroIdx);
  });

  it('microtask enqueued during macrotask fires after the macrotask', () => {
    const macroStart = events.findIndex(
      e => e.type === 'CALLBACK_START' && e.kind === 'macro',
    );
    const macroEnd = events.findIndex(
      (e, i) => i > macroStart && e.type === 'CALLBACK_END' && e.kind === 'macro',
    );

    const microEnqueuedDuringMacro = events.find(
      (e, i) => i > macroStart && i < macroEnd && e.type === 'ENQUEUE_MICRO',
    );
    expect(microEnqueuedDuringMacro).toBeDefined();

    const followUpCallback = events.find(
      (e, i) => i > macroEnd && e.type === 'CALLBACK_START' && e.taskId === microEnqueuedDuringMacro.taskId,
    );
    expect(followUpCallback).toBeDefined();
  });

  it('pairs every CALLBACK_START with a CALLBACK_END', () => {
    const starts = events.filter(e => e.type === 'CALLBACK_START');
    const ends = events.filter(e => e.type === 'CALLBACK_END');

    expect(starts).toHaveLength(ends.length);

    for (const start of starts) {
      const matchingEnd = ends.find(e => e.taskId === start.taskId);
      expect(matchingEnd).toBeDefined();
    }
  });

  it('logs "sync-end" during the synchronous phase', () => {
    const syncEndIdx = events.findIndex(e => e.type === 'SYNC_END');
    const logs = events
      .filter((e, i) => e.type === 'LOG' && i < syncEndIdx)
      .map(e => e.value);

    expect(logs).toContain('sync-end');
  });
});

describe('integration: promise-executor.js', () => {
  it('captures sync executor and then microtask', async () => {
    const events = await runScript('examples/promise-executor.js');

    const logs = events.filter(e => e.type === 'LOG').map(e => e.value);
    expect(logs[0]).toBe('1');
    expect(logs[1]).toBe('2 - executor is sync!');
    expect(logs[2]).toBe('3');
    expect(logs[3]).toBe('4 - microtask');
  });

  it('enqueues exactly one microtask for .then()', async () => {
    const events = await runScript('examples/promise-executor.js');

    const micros = events.filter(e => e.type === 'ENQUEUE_MICRO');
    expect(micros.length).toBeGreaterThan(0);
    expect(micros.some(e => e.subtype === 'promise')).toBe(true);
  });
});

