'use strict';

/** @typedef {import('./types').ElvEvent} ElvEvent */
/** @typedef {import('./types').InstrumenterOptions} InstrumenterOptions */
/** @typedef {import('./types').InstrumenterResult} InstrumenterResult */
/** @typedef {import('./types').InstrumenterState} InstrumenterState */

const async_hooks = require('async_hooks');
const fs = require('fs');
const _sep = require('path').sep;
const _ownDir = __dirname + _sep;
const _nodeModules = _sep + 'node_modules' + _sep;
const { safeSerialize } = require('./serialize');
const { parseFrame, getRawStack } = require('./stack-utils');

const MAX_LABEL_LENGTH = 60;
const TRUNCATION_SUFFIX = '...';
const TRUNCATED_LABEL_LENGTH = MAX_LABEL_LENGTH - TRUNCATION_SUFFIX.length;
const DEFAULT_MAX_EVENTS = 5000;
const DEFAULT_INTERVAL_CAP = 10;
const CONSOLE_METHODS = ['log', 'warn', 'error', 'info'];
const ELV_INTERNAL_PREFIX = '__elv';
const MAX_AWAIT_EXPR_LENGTH = 45;
const TRUNCATED_AWAIT_EXPR_LENGTH = MAX_AWAIT_EXPR_LENGTH - TRUNCATION_SUFFIX.length;

/**
 * Returns a human-readable label for a callback function, falling back to the provided default.
 * @param {Function | null | undefined} fn
 * @param {string} fallback
 * @returns {string}
 */
function getLabel(fn, fallback) {
  if (!fn || typeof fn !== 'function') return fallback;
  if (fn.name && !fn.name.startsWith(ELV_INTERNAL_PREFIX)) return fn.name;
  let fnString = fn.toString().replace(/\s+/g, ' ').trim();
  if (fnString.includes('[native code]')) return fallback;
  fnString = fnString.replace(/;?\s*__elv(?:Track|Step)\([^)]*\)\s*;?/g, '');
  if (fnString.length <= MAX_LABEL_LENGTH) return fnString;
  return fnString.substring(0, TRUNCATED_LABEL_LENGTH) + TRUNCATION_SUFFIX;
}

/**
 * Patches all async globals on `target` and records events.
 * @param {object} target - The global object to patch (e.g., `globalThis`, jsdom's `this.global`)
 * @param {InstrumenterOptions} [options]
 * @returns {InstrumenterResult}
 */
function createInstrumenter(target, options = {}) {
  const mode = options.mode || 'file';
  const maxEvents = options.maxEvents || parseInt(process.env.ELV_MAX_EVENTS, 10) || DEFAULT_MAX_EVENTS;
  const intervalCap = options.intervalCap || parseInt(process.env.ELV_INTERVAL_CAP, 10) || DEFAULT_INTERVAL_CAP;
  const filterNoise = mode !== 'file';
  const focusFile = options.focusFile || null;

  /** @type {ElvEvent[]} */
  const events = [];
  let seq = 0;
  let pendingTimers = 0;
  let lastEventTime = Date.now();
  let insideFocusCallback = 0;

  const _pendingTimerIds = new Set();

  // ── Focus-file helpers ──────────────────────────────────────────────

  const _focusPathCache = new Map();
  function isFocusFile(file) {
    if (file === focusFile) return true;
    if (_focusPathCache.has(file)) return _focusPathCache.get(file);
    let match = false;
    try { match = fs.realpathSync(file) === focusFile; } catch (_) {}
    _focusPathCache.set(file, match);
    return match;
  }

  // ── Event emitter ───────────────────────────────────────────────────

  let eventCapReached = false;
  /** @param {Partial<ElvEvent> & { type: import('./types').EventType }} event */
  function emit(event) {
    if (eventCapReached) return;
    if (events.length >= maxEvents) {
      eventCapReached = true;
      events.push(/** @type {ElvEvent} */ ({ type: 'EVENT_CAP_REACHED', seq: seq++, ts: Date.now(), value: String(maxEvents) }));
      return;
    }
    event.seq = seq++;
    event.ts = Date.now();
    lastEventTime = event.ts;
    events.push(/** @type {ElvEvent} */ (event));
  }

  /** @returns {InstrumenterState} */
  function getState() {
    return { pendingTimers, lastEventTime };
  }

  // ── Stack analysis ──────────────────────────────────────────────────

  /**
   * Single stack analysis that combines caller identification, noise detection,
   * and focus-file filtering. Returns everything wrappers need in one pass.
   */
  function checkCall() {
    const stack = getRawStack();
    if (!stack) return { loc: undefined, skip: true, external: false, focusLine: undefined };

    const frames = stack.split('\n');
    let loc = undefined;
    let focusFound = !focusFile;
    let focusLine = undefined;

    for (let i = 1; i < frames.length; i++) {
      const frame = frames[i];
      if (frame.includes(_ownDir) || frame.includes('node:')) continue;
      const parsed = parseFrame(frame);
      if (parsed) {
        if (!loc) loc = { file: parsed.file, line: parsed.line };
        if (focusFile && isFocusFile(parsed.file)) {
          focusFound = true;
          if (focusLine === undefined) focusLine = parsed.line;
        }
      }
    }

    let skip;
    if (focusFile) {
      skip = !focusFound && insideFocusCallback <= 0;
    } else {
      skip = filterNoise && (!loc || loc.file.includes(_nodeModules));
    }

    const external = focusFile ? (!loc || !isFocusFile(loc.file)) : false;

    return { loc, skip, external, focusLine };
  }

  function getUserCallerFromStack() {
    const stack = getRawStack();
    if (!stack) return undefined;
    const frames = stack.split('\n');
    for (let i = 1; i < frames.length; i++) {
      const frame = frames[i];
      if (frame.includes(_ownDir) || frame.includes('node:') || frame.includes(_nodeModules)) continue;
      if (frame.includes('async_hooks')) continue;
      const parsed = parseFrame(frame);
      if (parsed) return parsed;
    }
    return undefined;
  }

  function resolveCallSite(line, file) {
    let resolvedLine = line;
    let resolvedFile = file || undefined;
    const stack = getRawStack();
    if (stack) {
      const frames = stack.split('\n');
      for (let i = 1; i < frames.length; i++) {
        const frame = frames[i];
        if (frame.includes(_ownDir) || frame.includes('node:')) continue;
        const parsed = parseFrame(frame);
        if (parsed) {
          resolvedLine = parsed.line;
          resolvedFile = parsed.file;
          break;
        }
      }
    }
    return { line: resolvedLine, file: resolvedFile };
  }

  // ── DRY wrapper factories for macro / micro tasks ───────────────────

  /**
   * Creates a patched macro-task scheduler (setTimeout, setImmediate).
   * Handles: checkCall → skip → getLabel → ENQUEUE_MACRO → wrap callback
   * with CALLBACK_START/END and error handling.
   */
  function wrapMacro(original, subtype, defaultLabel) {
    return function __elvMacroWrapper(cb, ...rawArgs) {
      const { loc, skip, external, focusLine } = checkCall();
      if (skip) return original.call(this, cb, ...rawArgs);

      const label = getLabel(cb, defaultLabel(rawArgs));
      const taskId = seq;
      const locFields = { file: loc && loc.file, line: loc && loc.line, external: external || undefined, focusLine };

      emit({ type: 'ENQUEUE_MACRO', label, taskId, kind: 'macro', subtype, ...locFields });
      pendingTimers++;

      const callArgs = subtype === 'setTimeout' ? rawArgs.slice(1) : rawArgs;
      const timerId = original.call(this, function __elvMacroCb() {
        if (_pendingTimerIds.delete(timerId)) pendingTimers--;
        if (focusFile) insideFocusCallback++;
        emit({ type: 'CALLBACK_START', label, taskId, kind: 'macro', subtype, ...locFields });
        try {
          cb.apply(this, callArgs);
        } catch (err) {
          emit({ type: 'ERROR', value: err && err.message || String(err) });
          throw err;
        } finally {
          emit({ type: 'CALLBACK_END', taskId, kind: 'macro', subtype });
          if (focusFile) insideFocusCallback--;
        }
      }, subtype === 'setTimeout' ? rawArgs[0] : undefined);
      _pendingTimerIds.add(timerId);
      return timerId;
    };
  }

  /**
   * Creates a patched micro-task scheduler (queueMicrotask, process.nextTick).
   * Handles: checkCall → skip → getLabel → ENQUEUE_MICRO → wrap callback
   * with CALLBACK_START/END and error handling.
   */
  function wrapMicro(original, subtype, defaultLabel, callCtx) {
    return function __elvMicroWrapper(cb, ...args) {
      const { loc, skip, external, focusLine } = checkCall();
      if (skip) return original.call(callCtx || this, cb, ...args);

      const label = getLabel(cb, defaultLabel);
      const taskId = seq;
      const locFields = { file: loc && loc.file, line: loc && loc.line, external: external || undefined, focusLine };

      emit({ type: 'ENQUEUE_MICRO', label, taskId, kind: 'micro', subtype, ...locFields });

      return original.call(callCtx || this, function __elvMicroCb() {
        if (focusFile) insideFocusCallback++;
        emit({ type: 'CALLBACK_START', label, taskId, kind: 'micro', subtype, ...locFields });
        try {
          cb.apply(this, args);
        } catch (err) {
          emit({ type: 'ERROR', value: err && err.message || String(err) });
          throw err;
        } finally {
          emit({ type: 'CALLBACK_END', taskId, kind: 'micro', subtype });
          if (focusFile) insideFocusCallback--;
        }
      });
    };
  }

  // ── Save originals from the *target* object ─────────────────────────

  const _setTimeout = target.setTimeout;
  const _clearTimeout = target.clearTimeout;
  const _setInterval = target.setInterval;
  const _clearInterval = target.clearInterval;
  const _setImmediate = target.setImmediate;
  const _queueMicrotask = target.queueMicrotask;
  const _nextTick = (target.process && target.process.nextTick)
    ? target.process.nextTick
    : (typeof process !== 'undefined' ? process.nextTick : undefined);
  const _then = Promise.prototype.then;
  const _catch = Promise.prototype.catch;
  const _consoleMethods = {};
  if (target.console) {
    for (const method of CONSOLE_METHODS) {
      _consoleMethods[method] = target.console[method];
    }
  }

  // ── Patch clear functions (must track cancelled timers) ─────────────

  target.clearTimeout = function __elvClearTimeout(id) {
    if (_pendingTimerIds.delete(id)) pendingTimers--;
    return _clearTimeout.call(this, id);
  };

  target.clearInterval = function __elvClearInterval(id) {
    if (_pendingTimerIds.delete(id)) pendingTimers--;
    return _clearInterval.call(this, id);
  };

  // ── Patch macrotasks ────────────────────────────────────────────────

  target.setTimeout = wrapMacro(_setTimeout, 'setTimeout', (args) => 'setTimeout(fn, ' + (args[0] || 0) + ')');

  if (_setImmediate) {
    target.setImmediate = wrapMacro(_setImmediate, 'setImmediate', () => 'setImmediate(fn)');
  }

  // setInterval stays hand-written due to iteration-cap logic
  target.setInterval = function __elvSetInterval(cb, delay, ...args) {
    const { loc, skip, external, focusLine } = checkCall();
    if (skip) return _setInterval.call(this, cb, delay, ...args);

    const label = getLabel(cb, 'setInterval(fn, ' + (delay || 0) + ')');
    let iteration = 0;
    const taskId = seq;
    const locFields = { file: loc && loc.file, line: loc && loc.line, external: external || undefined, focusLine };

    emit({ type: 'ENQUEUE_MACRO', label, taskId, kind: 'macro', subtype: 'setInterval', ...locFields });
    pendingTimers++;

    const intervalId = _setInterval.call(this, function __elvIntervalCb() {
      iteration++;
      if (iteration > intervalCap) { cb.apply(this, args); return; }

      if (focusFile) insideFocusCallback++;
      const iterTaskId = iteration === 1 ? taskId : seq;
      if (iteration > 1) {
        emit({ type: 'ENQUEUE_MACRO', label: label + ' (#' + iteration + ')', taskId: iterTaskId, kind: 'macro', subtype: 'setInterval' });
      }
      emit({ type: 'CALLBACK_START', label: label + ' (#' + iteration + ')', taskId: iterTaskId, kind: 'macro', subtype: 'setInterval' });
      try {
        cb.apply(this, args);
      } catch (err) {
        emit({ type: 'ERROR', value: err && err.message || String(err) });
        throw err;
      } finally {
        emit({ type: 'CALLBACK_END', taskId: iterTaskId, kind: 'macro', subtype: 'setInterval' });
        if (focusFile) insideFocusCallback--;
      }
    }, delay);
    _pendingTimerIds.add(intervalId);
    return intervalId;
  };

  // ── Patch microtasks ────────────────────────────────────────────────

  if (_queueMicrotask) {
    target.queueMicrotask = wrapMicro(_queueMicrotask, 'queueMicrotask', 'queueMicrotask(fn)');
  }

  if (_nextTick) {
    const proc = target.process || process;
    proc.nextTick = wrapMicro(_nextTick, 'nextTick', 'process.nextTick(fn)', proc);
  }

  // ── Await label enrichment via source file cache ────────────────────

  const _srcLineCache = new Map();

  function getSourceLineContent(file, line) {
    if (!file || !line) return null;
    if (!_srcLineCache.has(file)) {
      try {
        _srcLineCache.set(file, fs.readFileSync(file, 'utf8').split('\n'));
      } catch (_) {
        _srcLineCache.set(file, null);
      }
    }
    const lines = _srcLineCache.get(file);
    return lines ? (lines[line - 1] || null) : null;
  }

  function buildAwaitLabel(loc) {
    const srcLine = getSourceLineContent(loc.file, loc.line);
    if (srcLine) {
      const m = srcLine.match(/await\s+(.+)/);
      if (m) {
        let expr = m[1].replace(/;?\s*$/, '').trim();
        if (expr.length > MAX_AWAIT_EXPR_LENGTH) expr = expr.substring(0, TRUNCATED_AWAIT_EXPR_LENGTH) + TRUNCATION_SUFFIX;
        return 'await ' + expr;
      }
    }
    return 'await (line ' + loc.line + ')';
  }

  // ── async_hooks for native await/Promise tracking ───────────────────

  const _trackedAsyncIds = new Map();
  const _thenPatchedAsyncIds = new Set();

  const _asyncHook = async_hooks.createHook({
    init(asyncId, type) {
      if (type !== 'PROMISE') return;
      if (eventCapReached) return;

      const execId = async_hooks.executionAsyncId();
      if (_thenPatchedAsyncIds.has(execId)) return;

      const loc = getUserCallerFromStack();
      if (!loc) return;
      if (focusFile && !isFocusFile(loc.file) && insideFocusCallback <= 0) return;

      const external = focusFile ? !isFocusFile(loc.file) : false;
      const label = buildAwaitLabel(loc);

      _trackedAsyncIds.set(asyncId, { loc, external, label, emitted: false });
    },

    before(asyncId) {
      const tracked = _trackedAsyncIds.get(asyncId);
      if (!tracked) return;

      if (!tracked.emitted) {
        tracked.taskId = seq;
        tracked.emitted = true;
        emit({
          type: 'ENQUEUE_MICRO', label: tracked.label, taskId: tracked.taskId,
          kind: 'micro', subtype: 'promise',
          file: tracked.loc.file, line: tracked.loc.line, external: tracked.external || undefined,
        });
      }

      if (focusFile) insideFocusCallback++;
      emit({
        type: 'CALLBACK_START', label: tracked.label, taskId: tracked.taskId,
        kind: 'micro', subtype: 'promise',
        file: tracked.loc.file, line: tracked.loc.line, external: tracked.external || undefined,
      });
    },

    after(asyncId) {
      _thenPatchedAsyncIds.delete(asyncId);
      const tracked = _trackedAsyncIds.get(asyncId);
      if (!tracked || !tracked.emitted) return;
      emit({ type: 'CALLBACK_END', taskId: tracked.taskId, kind: 'micro', subtype: 'promise' });
      if (focusFile) insideFocusCallback--;
      _trackedAsyncIds.delete(asyncId);
    },
  });

  _asyncHook.enable();

  // ── Promise.prototype.then (hand-written — fulfilled/rejected branching) ──

  let microId = 0;
  const alreadyPatched = /** @type {any} */ (Promise.prototype.then).__elvPatched;

  if (!alreadyPatched) {
  Promise.prototype.then = function __elvThen(onFulfilled, onRejected) {
    const hasFulfilled = typeof onFulfilled === 'function';
    const hasRejected = typeof onRejected === 'function';

    if (!hasFulfilled && !hasRejected) return _then.call(this, onFulfilled, onRejected);

    const { loc, skip, external, focusLine } = checkCall();
    if (skip) return _then.call(this, onFulfilled, onRejected);

    const id = microId++;
    const primaryFn = hasFulfilled ? onFulfilled : onRejected;
    const fallback = 'Promise.then(#' + id + ')';
    const label = getLabel(primaryFn, fallback);

    if (filterNoise && label === fallback) return _then.call(this, onFulfilled, onRejected);

    const taskId = seq;
    const locFields = { file: loc && loc.file, line: loc && loc.line, external: external || undefined, focusLine };

    _thenPatchedAsyncIds.add(async_hooks.executionAsyncId());
    emit({ type: 'ENQUEUE_MICRO', label, taskId, kind: 'micro', subtype: 'promise', ...locFields });

    const wrappedFulfilled = hasFulfilled
      ? function __elvFulfilled(value) {
          if (focusFile) insideFocusCallback++;
          emit({ type: 'CALLBACK_START', label, taskId, kind: 'micro', subtype: 'promise', ...locFields });
          try { return onFulfilled(value); }
          catch (err) { emit({ type: 'ERROR', value: err && err.message || String(err) }); throw err; }
          finally { emit({ type: 'CALLBACK_END', taskId, kind: 'micro', subtype: 'promise' }); if (focusFile) insideFocusCallback--; }
        }
      : onFulfilled;

    const wrappedRejected = hasRejected
      ? function __elvRejected(reason) {
          if (focusFile) insideFocusCallback++;
          if (!hasFulfilled) emit({ type: 'CALLBACK_START', label, taskId, kind: 'micro', subtype: 'promise', ...locFields });
          try { return onRejected(reason); }
          catch (err) { emit({ type: 'ERROR', value: err && err.message || String(err) }); throw err; }
          finally {
            if (!hasFulfilled) emit({ type: 'CALLBACK_END', taskId, kind: 'micro', subtype: 'promise' });
            if (focusFile) insideFocusCallback--;
          }
        }
      : onRejected;

    return _then.call(this, wrappedFulfilled, wrappedRejected);
  };

  /** @type {any} */ (Promise.prototype.then).__elvPatched = true;
  Promise.prototype.catch = function __elvCatch(onRejected) { return this.then(undefined, onRejected); };
  }

  // ── Console methods ─────────────────────────────────────────────────

  if (target.console) {
    for (const method of CONSOLE_METHODS) {
      const orig = _consoleMethods[method];
      target.console[method] = function __elvConsole(...consoleArgs) {
        const { loc, skip, external, focusLine } = checkCall();
        if (!skip) {
          const value = consoleArgs.map(a => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch { return String(a); }
          }).join(' ');
          emit({ type: 'LOG', value, subtype: method, file: loc && loc.file, line: loc && loc.line, external: external || undefined, focusLine });
        }
        if (mode !== 'file') orig.apply(target.console, consoleArgs);
      };
    }
  }

  // ── __elvTrack / __elvStep (injected by transform.js) ───────────────

  target.__elvTrack = function __elvTrack(name, value, line, file) {
    if (/^(cov_|__coverage|gcv$|actualCoverage$|coverageData$)/.test(name)) return;
    const site = resolveCallSite(line, file);
    emit({ type: 'MEMORY', label: name, value: safeSerialize(value), line: site.line, file: site.file });
  };

  target.__elvStep = function __elvStep(line, label, file) {
    const site = resolveCallSite(line, file);
    emit({ type: 'SYNC_STEP', label: label || '', line: site.line, file: site.file });
  };

  // ── Restore ─────────────────────────────────────────────────────────

  function restore() {
    _asyncHook.disable();
    _trackedAsyncIds.clear();
    _thenPatchedAsyncIds.clear();
    target.setTimeout = _setTimeout;
    target.clearTimeout = _clearTimeout;
    target.setInterval = _setInterval;
    target.clearInterval = _clearInterval;
    if (_setImmediate) target.setImmediate = _setImmediate;
    if (_queueMicrotask) target.queueMicrotask = _queueMicrotask;
    if (_nextTick) {
      const proc = target.process || process;
      proc.nextTick = _nextTick;
    }
    if (!alreadyPatched) {
      Promise.prototype.then = _then;
      Promise.prototype.catch = _catch;
    }
    if (target.console) {
      for (const method of CONSOLE_METHODS) {
        target.console[method] = _consoleMethods[method];
      }
    }
    delete target.__elvTrack;
    delete target.__elvStep;
  }

  return {
    events, emit, getState, restore,
    originals: {
      setTimeout: _setTimeout, clearTimeout: _clearTimeout,
      setInterval: _setInterval, clearInterval: _clearInterval,
      setImmediate: _setImmediate, queueMicrotask: _queueMicrotask,
      nextTick: _nextTick,
    },
  };
}

module.exports = { createInstrumenter };
