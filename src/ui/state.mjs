import chalk from 'chalk';
import { MAX_MEMORY_DISPLAY_LEN } from './constants.mjs';

export const PHASE_COLORS = {
  'Ready': { primary: 'gray', accent: 'gray' },
  'Synchronous': { primary: 'green', accent: 'greenBright' },
  'Sync Complete': { primary: 'green', accent: 'greenBright' },
  'Microtasks': { primary: 'cyan', accent: 'cyanBright' },
  'Macrotasks': { primary: 'redBright', accent: 'redBright' },
  'Complete': { primary: 'gray', accent: 'gray' },
};

/** @returns {import('../types').TUIState} */
export function createInitialState() {
  return {
    callStack: [],
    microQueue: [],
    macroQueue: [],
    console: [],
    log: [],
    phase: 'Ready',
    memory: new Map(),
    startTs: 0,
    prevTs: 0,
    currentTest: null,
  };
}

/**
 * Mutates state based on an event, updating queues, call stack, phase, and log.
 * Log entries use chalk formatting (ANSI escape codes) for colored terminal output.
 * @param {import('../types').TUIState} state
 * @param {import('../types').ElvEvent} event
 * @returns {void}
 */
export function applyEvent(state, event) {
  const fileTag = (event.external && event.file)
    ? ' ' + chalk.gray('\u21AA ' + event.file.split(/[\/\\]/).pop())
    : '';

  const delta = (event.ts && state.prevTs) ? event.ts - state.prevTs : 0;
  const ts = chalk.gray(('+' + delta + 'ms').padStart(7)) + ' ';
  if (event.ts) state.prevTs = event.ts;

  switch (event.type) {
    case 'SYNC_START':
      if (event.ts) { state.startTs = event.ts; state.prevTs = event.ts; }
      state.callStack.push('<script>' + (event.label ? ' ' + event.label : ''));
      state.phase = 'Synchronous';
      state.log.push(ts + chalk.bgGreen.black.bold(' START ') + ' Script execution started');
      break;

    case 'SYNC_END':
      state.callStack = [];
      state.phase = 'Sync Complete';
      state.log.push(ts + chalk.green('\u2500\u2500\u2500') + chalk.green.bold(' Synchronous phase complete ') + chalk.green('\u2500\u2500\u2500'));
      break;

    case 'LOG': {
      const val = event.value || '';
      state.console.push('> ' + val);
      state.log.push(ts + chalk.gray('\u2502') + ' ' + val + fileTag);
      break;
    }

    case 'ENQUEUE_MACRO': {
      const label = event.label || 'macrotask';
      state.macroQueue.push({ label, taskId: event.taskId });
      state.log.push(ts + chalk.bgRedBright.black('  +T   ') + ' ' + chalk.redBright('\u2192') + ' ' + label + fileTag);
      break;
    }

    case 'ENQUEUE_MICRO': {
      const label = event.label || 'microtask';
      state.microQueue.push({ label, taskId: event.taskId });
      state.log.push(ts + chalk.bgCyan.black('  +M   ') + ' ' + chalk.cyan('\u2192') + ' ' + label + fileTag);
      break;
    }

    case 'CALLBACK_START': {
      const label = event.label || 'callback';
      if (event.kind === 'micro') {
        state.microQueue = state.microQueue.filter(item => item.taskId !== event.taskId);
        state.phase = 'Microtasks';
        state.log.push(ts + chalk.bgCyan.black('  \u25B6M   ') + ' ' + chalk.cyanBright.bold(label) + fileTag);
      } else {
        state.macroQueue = state.macroQueue.filter(item => item.taskId !== event.taskId);
        state.phase = 'Macrotasks';
        state.log.push(ts + chalk.bgRedBright.black('  \u25B6T   ') + ' ' + chalk.redBright.bold(label) + fileTag);
      }
      state.callStack.push(label);
      break;
    }

    case 'CALLBACK_END':
      if (state.callStack.length > 0) state.callStack.pop();
      break;

    case 'ERROR': {
      const msg = event.value || 'Unknown error';
      state.log.push(ts + chalk.bgRed.white.bold(' ERROR ') + ' ' + chalk.red(msg));
      break;
    }

    case 'MEMORY':
      if (event.label) {
        const val = event.value || 'undefined';
        state.memory.set(event.label, val);
        const truncatedValue = val.length > MAX_MEMORY_DISPLAY_LEN
          ? val.substring(0, MAX_MEMORY_DISPLAY_LEN - 3) + '...'
          : val;
        state.log.push(ts + chalk.bgMagenta.white('  VAR  ') + ' ' + chalk.magentaBright(event.label) + ' = ' + truncatedValue + fileTag);
      }
      break;

    case 'TEST_START': {
      const testName = event.label || 'test';
      state.currentTest = testName;
      state.callStack = [];
      state.memory = new Map();
      state.phase = 'Synchronous';
      state.log.push('');
      state.log.push(ts + chalk.bgGreen.black.bold(' TEST  ') + ' ' + chalk.greenBright.bold(testName));
      break;
    }

    case 'TEST_END': {
      const testName = event.label || 'test';
      const passed = event.value === 'pass';
      if (passed) {
        state.log.push(ts + chalk.bgGreen.black.bold(' PASS  ') + ' ' + chalk.green(testName));
      } else {
        state.log.push(ts + chalk.bgRed.white.bold(' FAIL  ') + ' ' + chalk.red(testName));
      }
      state.currentTest = null;
      break;
    }

    case 'SYNC_STEP': {
      const label = event.label || '';
      state.log.push('        ' + chalk.gray('\u2502 ') + chalk.dim(label));
      break;
    }

    case 'EVENT_CAP_REACHED': {
      const cap = event.value || '5000';
      state.log.push(ts + chalk.bgRed.white.bold(' WARN  ') + ' ' + chalk.red('Event cap reached (' + cap + '). Set ELV_MAX_EVENTS for higher.'));
      break;
    }

    case 'DONE':
      state.phase = 'Complete';
      state.callStack = [];
      state.log.push(ts + chalk.bgWhite.black.bold(' DONE  ') + ' ' + chalk.green('\u2713 Execution complete'));
      break;
  }
}

export function cloneState(s) {
  return structuredClone(s);
}
