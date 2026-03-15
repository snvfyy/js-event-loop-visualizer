import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { createElement } from 'react';
import { App } from '../src/ui.mjs';

const h = createElement;

const KEY_RIGHT = '\x1b[C';
const KEY_LEFT = '\x1b[D';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

const SOURCE_CODE = [
  '// async-await demo',
  'async function fetchData() {',
  "  console.log('1 - start');",
  "  const result = await Promise.resolve('data');",
  "  console.log('2 - after await: ' + result);",
  '}',
  'fetchData();',
  "console.log('3 - sync after call');",
].join('\n');

const EVENTS = [
  /* 0  */ { type: 'SYNC_START', label: 'demo.js', seq: 0, ts: 1000 },
  /* 1  */ { type: 'LOG', value: '1 - start', subtype: 'log', seq: 1, ts: 1001 },
  /* 2  */ { type: 'SYNC_STEP', label: 'fetchData()', line: 7, seq: 2, ts: 1002 },
  /* 3  */ { type: 'LOG', value: '3 - sync after call', subtype: 'log', seq: 3, ts: 1003 },
  /* 4  */ { type: 'SYNC_END', seq: 4, ts: 1004 },
  /* 5  */ { type: 'ENQUEUE_MICRO', label: 'await Promise.resolve()', taskId: 5, kind: 'micro', subtype: 'promise', line: 4, seq: 5, ts: 1005 },
  /* 6  */ { type: 'CALLBACK_START', label: 'await Promise.resolve()', taskId: 5, kind: 'micro', subtype: 'promise', seq: 6, ts: 1006 },
  /* 7  */ { type: 'CALLBACK_END', taskId: 5, kind: 'micro', subtype: 'promise', seq: 7, ts: 1007 },
  /* 8  */ { type: 'ENQUEUE_MICRO', label: 'await result', taskId: 8, kind: 'micro', subtype: 'promise', line: 4, seq: 8, ts: 1008 },
  /* 9  */ { type: 'CALLBACK_START', label: 'await result', taskId: 8, kind: 'micro', subtype: 'promise', seq: 9, ts: 1009 },
  /* 10 */ { type: 'MEMORY', label: 'result', value: '"data"', seq: 10, ts: 1010 },
  /* 11 */ { type: 'LOG', value: '2 - after await: data', subtype: 'log', seq: 11, ts: 1011 },
  /* 12 */ { type: 'CALLBACK_END', taskId: 8, kind: 'micro', subtype: 'promise', seq: 12, ts: 1012 },
  /* 13 */ { type: 'DONE', seq: 13, ts: 1013 },
];

const MACRO_EVENTS = [
  /* 0 */ { type: 'SYNC_START', label: 'timer.js', seq: 0, ts: 1000 },
  /* 1 */ { type: 'ENQUEUE_MACRO', label: 'setTimeout(fn, 0)', taskId: 1, kind: 'macro', subtype: 'setTimeout', seq: 1, ts: 1001 },
  /* 2 */ { type: 'SYNC_END', seq: 2, ts: 1002 },
  /* 3 */ { type: 'CALLBACK_START', label: 'setTimeout(fn, 0)', taskId: 1, kind: 'macro', subtype: 'setTimeout', seq: 3, ts: 1003 },
  /* 4 */ { type: 'LOG', value: 'timer fired', subtype: 'log', seq: 4, ts: 1004 },
  /* 5 */ { type: 'CALLBACK_END', taskId: 1, kind: 'macro', subtype: 'setTimeout', seq: 5, ts: 1005 },
  /* 6 */ { type: 'DONE', seq: 6, ts: 1006 },
];

/** Matches the "Step N/Total" counter in the TUI header. */
const stepCounter = (n, total = 14) => new RegExp(`Step\\s+${n}\\/${total}`);

function renderApp(events = EVENTS, sourceCode = SOURCE_CODE) {
  return render(
    h(App, { events, sourceCode, sourcePath: '/test/demo.js', focusFile: null }),
  );
}

/**
 * Render, wait for hooks to attach, then return the instance.
 * The initial sleep lets Ink's useInput/useEffect hooks register
 * before we send any keyboard input.
 */
async function renderAndWait(events, sourceCode) {
  const instance = renderApp(events, sourceCode);
  await sleep(100);
  return instance;
}

/** Send N right-arrow keystrokes with a pause between each. */
async function stepForward(stdin, n) {
  for (let i = 0; i < n; i++) {
    stdin.write(KEY_RIGHT);
    await sleep(50);
  }
  await sleep(100);
}

function getFrame(lastFrame) {
  return stripAnsi(lastFrame() ?? '');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('initial layout', () => {
  afterEach(() => { cleanup(); });

  it('shows all six panel labels and the source code', () => {
    const frame = getFrame(renderApp().lastFrame);

    expect(frame).toContain('Call Stack');
    expect(frame).toContain('Microtask Queue');
    expect(frame).toContain('Macrotask Queue');
    expect(frame).toContain('Console Output');
    expect(frame).toContain('Event Log');
    expect(frame).toContain('Memory');
    expect(frame).toContain('fetchData');
    expect(frame).toContain('Promise.resolve');
  });

  it('starts at step 0 in the "Ready" phase', () => {
    const frame = getFrame(renderApp().lastFrame);

    expect(frame).toContain('Event Loop Visualizer');
    expect(frame).toMatch(stepCounter(0));
    expect(frame).toContain('Ready');
    expect(frame).not.toContain('Synchronous');
    expect(frame).not.toContain('Complete');
  });

  it('displays keybinding hints in the footer bar', () => {
    const frame = getFrame(renderApp().lastFrame);

    expect(frame).toContain('Play');
    expect(frame).toContain('Reset');
  });

  it('panels start empty before any events are applied', () => {
    const frame = getFrame(renderApp().lastFrame);

    expect(frame).toContain('(empty)');
    expect(frame).toContain('(no variables tracked)');
    expect(frame).not.toContain('<script>');
    expect(frame).not.toContain('> 1 - start');
  });
});

describe('stepping through events with arrow keys', () => {
  afterEach(() => { cleanup(); });

  it('pressing → once moves to step 1 and enters the "Synchronous" phase', async () => {
    const { lastFrame, stdin } = await renderAndWait();

    const before = getFrame(lastFrame);
    expect(before).not.toContain('Synchronous');

    stdin.write(KEY_RIGHT);
    await sleep(100);

    const after = getFrame(lastFrame);
    expect(after).toMatch(stepCounter(1));
    expect(after).toContain('Synchronous');
  });

  it('pressing ← after two → steps goes back to step 1', async () => {
    const { lastFrame, stdin } = await renderAndWait();

    await stepForward(stdin, 2);
    expect(getFrame(lastFrame)).toMatch(stepCounter(2));

    stdin.write(KEY_LEFT);
    await sleep(100);

    expect(getFrame(lastFrame)).toMatch(stepCounter(1));
  });

  it('stepping through all 14 events reaches the "Complete" phase', async () => {
    const { lastFrame, stdin } = await renderAndWait();

    const before = getFrame(lastFrame);
    expect(before).not.toContain('Complete');

    await stepForward(stdin, EVENTS.length);

    const after = getFrame(lastFrame);
    expect(after).toContain('Complete');
    expect(after).toMatch(stepCounter(14));
  });
});

describe('panel contents update as events are applied', () => {
  afterEach(() => { cleanup(); });

  it('SYNC_START pushes "<script>" onto the call stack', async () => {
    const { lastFrame, stdin } = await renderAndWait();

    expect(getFrame(lastFrame)).not.toContain('<script>');

    await stepForward(stdin, 1); // → event 0: SYNC_START

    expect(getFrame(lastFrame)).toContain('<script>');
  });

  it('LOG events appear in the console panel prefixed with ">"', async () => {
    const { lastFrame, stdin } = await renderAndWait();

    expect(getFrame(lastFrame)).not.toContain('> 1 - start');

    await stepForward(stdin, 2); // → event 1: LOG '1 - start'

    expect(getFrame(lastFrame)).toContain('> 1 - start');
  });

  it('ENQUEUE_MICRO adds the await label to the microtask queue', async () => {
    const { lastFrame, stdin } = await renderAndWait();

    expect(getFrame(lastFrame)).not.toContain('await Promise.resolve()');

    await stepForward(stdin, 6); // → event 5: ENQUEUE_MICRO

    expect(getFrame(lastFrame)).toContain('await Promise.resolve()');
  });

  it('MEMORY events display "variable = value" in the memory panel', async () => {
    const { lastFrame, stdin } = await renderAndWait();

    expect(getFrame(lastFrame)).toContain('(no variables tracked)');
    expect(getFrame(lastFrame)).not.toContain('result = "data"');

    await stepForward(stdin, 11); // → event 10: MEMORY result = "data"

    const after = getFrame(lastFrame);
    expect(after).toContain('result = "data"');
    expect(after).not.toContain('(no variables tracked)');
  });
});

describe('memory highlight on backward navigation', () => {
  afterEach(() => { cleanup(); });

  it('stepping back does not falsely highlight all memory variables as changed', async () => {
    const { lastFrame, stdin } = await renderAndWait();

    // Step to event 10 (MEMORY result = "data") — variable appears, highlighted as new
    await stepForward(stdin, 11);
    // Step one more (event 11: LOG) — variable still present, no longer "new"
    await stepForward(stdin, 1);

    const afterForward = lastFrame() ?? '';
    expect(stripAnsi(afterForward)).toContain('result = "data"');

    stdin.write(KEY_LEFT);
    await sleep(100);

    const afterBack = lastFrame() ?? '';
    expect(stripAnsi(afterBack)).toContain('result = "data"');

    const bgYellow = '\x1b[43m';
    // Check only lines that display the memory variable.
    const memoryLines = afterBack.split('\n').filter(l => stripAnsi(l).includes('result ='));
    for (const line of memoryLines) {
      expect(line).not.toContain(bgYellow);
    }
  });
});

describe('layout width with tab-indented source code', () => {
  afterEach(() => { cleanup(); });

  const TAB_SOURCE = [
    'import x from "blablabla";',
    '',
    'test("rate-limit", async () => {',
    '\tconst queue = new PQueue({',
    '\t\tinterval: 100,',
    '\t\tintervalCap: 1,',
    '\t\tautoStart: false,',
    '\t});',
    '',
    '\tconst results = [];',
    '\tfor (let i = 0; i < 4; i++) {',
    '\t\tpromises.push(queue.add(async () => {',
    '\t\t\tresults.push(i);',
    '\t\t\treturn i;',
    '\t\t}));',
    '\t}',
    '});',
  ].join('\n');

  const TAB_EVENTS = [
    { type: 'SYNC_START', label: 'rate-limit.ts', seq: 0, ts: 1000 },
    { type: 'ENQUEUE_MACRO', label: 'setTimeout(fn, 100)', taskId: 1, kind: 'macro', subtype: 'setTimeout', seq: 1, ts: 1001 },
    { type: 'ENQUEUE_MICRO', label: 'Promise.resolve()', taskId: 2, kind: 'micro', subtype: 'promise', seq: 2, ts: 1002, line: 4 },
    { type: 'LOG', value: 'task executed', subtype: 'log', seq: 3, ts: 1003 },
    { type: 'SYNC_END', seq: 4, ts: 1004 },
    { type: 'CALLBACK_START', label: 'Promise.resolve()', taskId: 2, kind: 'micro', subtype: 'promise', seq: 5, ts: 1005 },
    { type: 'CALLBACK_END', taskId: 2, kind: 'micro', subtype: 'promise', seq: 6, ts: 1006 },
    { type: 'CALLBACK_START', label: 'setTimeout(fn, 100)', taskId: 1, kind: 'macro', subtype: 'setTimeout', seq: 7, ts: 1007 },
    { type: 'CALLBACK_END', taskId: 1, kind: 'macro', subtype: 'setTimeout', seq: 8, ts: 1008 },
    { type: 'DONE', seq: 9, ts: 1009 },
  ];

  const INK_DEFAULT_COLS = 100;

  function displayWidth(str) {
    return str.replace(/\t/g, '        ').length;
  }

  function assertNoLineOverflow(frame) {
    const lines = stripAnsi(frame).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const w = displayWidth(lines[i]);
      expect(w, `line ${i + 1} overflows (${w} > ${INK_DEFAULT_COLS}): ${lines[i]}`).toBeLessThanOrEqual(INK_DEFAULT_COLS);
    }
  }

  it('tabs in source code are converted to spaces before rendering', () => {
    const frame = getFrame(renderApp(TAB_EVENTS, TAB_SOURCE).lastFrame);
    expect(frame).not.toContain('\t');
  });

  it('no line exceeds terminal width on initial render', () => {
    const frame = getFrame(renderApp(TAB_EVENTS, TAB_SOURCE).lastFrame);
    assertNoLineOverflow(frame);
  });

  it('no line exceeds terminal width after stepping through events', async () => {
    const { lastFrame, stdin } = await renderAndWait(TAB_EVENTS, TAB_SOURCE);

    await stepForward(stdin, 5);
    assertNoLineOverflow(getFrame(lastFrame));

    await stepForward(stdin, TAB_EVENTS.length - 5);
    assertNoLineOverflow(getFrame(lastFrame));
  });
});

describe('macrotask lifecycle', () => {
  afterEach(() => { cleanup(); });

  it('ENQUEUE_MACRO places "setTimeout(fn, 0)" in the macrotask queue', async () => {
    const { lastFrame, stdin } = await renderAndWait(MACRO_EVENTS, '// timer code');

    expect(getFrame(lastFrame)).not.toContain('setTimeout(fn, 0)');

    await stepForward(stdin, 2); // → event 1: ENQUEUE_MACRO

    expect(getFrame(lastFrame)).toContain('setTimeout(fn, 0)');
  });

  it('CALLBACK_START for a macrotask switches the phase to "Macrotasks"', async () => {
    const { lastFrame, stdin } = await renderAndWait(MACRO_EVENTS, '// timer code');

    expect(getFrame(lastFrame)).not.toContain('Macrotasks');

    await stepForward(stdin, 4); // → event 3: CALLBACK_START (macro)

    expect(getFrame(lastFrame)).toContain('Macrotasks');
  });
});
