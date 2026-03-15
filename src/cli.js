'use strict';

/** @typedef {import('./types').ElvEvent} ElvEvent */
/** @typedef {import('./types').ProcessEventFile} ProcessEventFile */

const { fork, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { classifyProcess } = require('./classify');

const DEFAULT_TIMEOUT_MS = 30000;
const EVENT_FILE_PREFIX = 'events-';

/** Escape a file path for embedding in a single-quoted JS string literal. */
function escapeForJS(str) {
  return str
    .replace(/\\/g, '/')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Shell-escape an argument by single-quoting it. */
function shellEscape(arg) {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/** Detect the project's package manager by looking for lock files. */
function detectPackageRunner() {
  if (fs.existsSync(path.join(process.cwd(), 'pnpm-lock.yaml'))) return 'pnpm exec';
  if (fs.existsSync(path.join(process.cwd(), 'yarn.lock'))) return 'yarn';
  return 'npx';
}

/**
 * CLI entry point. Parses argv and dispatches to the appropriate mode.
 * @param {string[]} argv - Arguments (typically process.argv.slice(2))
 */
function main(argv) {
  const args = argv.slice();

  if (process.platform === 'win32') {
    process.stderr.write(
      'Error: js-elv does not support Windows natively.\n' +
      'Hint: Use WSL (Windows Subsystem for Linux) or Git Bash.\n'
    );
    process.exit(1);
  }

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-V')) {
    const { version } = require('../package.json');
    process.stdout.write('js-elv v' + version + '\n');
    process.exit(0);
  }

  const focusIndex = args.indexOf('--focus');
  let focusFile = null;
  if (focusIndex !== -1) {
    focusFile = args[focusIndex + 1];
    if (!focusFile) {
      process.stderr.write('Error: --focus requires a file path.\n');
      process.exit(1);
    }
    focusFile = path.resolve(focusFile);
    if (!fs.existsSync(focusFile)) {
      process.stderr.write('Error: focus file not found: ' + focusFile + '\n');
      process.exit(1);
    }
    try { focusFile = fs.realpathSync(focusFile); } catch (_) {}
    args.splice(focusIndex, 2);
  }

  const firstArg = args[0];

  if (firstArg === 'jest' || firstArg === 'vitest') {
    const runner = firstArg;
    const runnerArgs = args.slice(1);

    if (runner === 'vitest' && !runnerArgs.includes('run') && !runnerArgs.includes('bench')) {
      process.stderr.write(
        'Warning: `js-elv vitest` without "run" starts watch mode, which is not supported.\n' +
        'Hint:    js-elv vitest run' + (runnerArgs.length ? ' ' + runnerArgs.join(' ') : '') + '\n'
      );
      process.exit(1);
    }

    const pkgRunner = detectPackageRunner();
    const command = pkgRunner + ' ' + runner + (runnerArgs.length ? ' ' + runnerArgs.map(shellEscape).join(' ') : '');

    if (!focusFile) {
      focusFile = autoDetectFocusFromArgs(runnerArgs);
    }

    runCommandMode(command, focusFile);
  } else if (firstArg === '--cmd') {
    const command = args[1];
    if (!command) {
      process.stderr.write('Error: --cmd requires a command string.\nHint:  js-elv --cmd "node server.js"\n');
      process.exit(1);
    }
    runCommandMode(command, focusFile);
  } else {
    const scriptPath = firstArg;
    if (!fs.existsSync(scriptPath)) {
      const suggestion = scriptPath.includes('test') || scriptPath.includes('spec')
        ? '\nHint:  js-elv vitest run ' + scriptPath + '  (for test files)'
        : '\nHint:  js-elv <script.js>  or  js-elv --help';
      process.stderr.write('Error: file not found: ' + scriptPath + suggestion + '\n');
      process.exit(1);
    }
    runFileMode(scriptPath, focusFile);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

/** @returns {void} */
function printHelp() {
  process.stdout.write([
    '',
    '  Event Loop Visualizer (js-elv)',
    '',
    '  Usage:',
    '    js-elv <script.js>              Run a JS file and visualize its event loop',
    '    js-elv jest <jest-args>          Run Jest tests and visualize async activity',
    '    js-elv vitest <vitest-args>      Run Vitest tests and visualize async activity',
    '    js-elv --cmd "<command>"         Run any command and visualize captured events',
    '    js-elv --focus <file>            Only capture events related to this file',
    '',
    '  Examples:',
    '    js-elv examples/async-await.js',
    '    js-elv jest --testPathPatterns MyTest',
    '    js-elv vitest run src/utils.test.ts',
    '    js-elv jest --testPathPatterns MyTest --focus src/__tests__/MyTest.spec.ts',
    '    js-elv --cmd "node server.js"',
    '    js-elv --cmd "pnpm nx run my-project:test --skip-nx-cache"',
    '    js-elv --cmd "node app.js" --focus src/services/auth.js',
    '',
    '  Options:',
    '    --help, -h                       Show this help message',
    '    --version, -V                    Show version number',
    '',
    '  Environment:',
    '    ELV_TIMEOUT        Safety timeout in ms (default: 30000)',
    '    ELV_MAX_EVENTS     Max events per process (default: 5000)',
    '    ELV_INTERVAL_CAP   Max setInterval iterations to record (default: 10)',
    '',
    '  Note: js-elv auto-detects your package manager (pnpm/yarn/npx) from lock files.',
    '',
  ].join('\n') + '\n');
}

/**
 * Fork runner.js, collect events via IPC, and launch the TUI.
 * @param {string} scriptPath
 * @param {string | null} focusFile
 * @returns {void}
 */
function runFileMode(scriptPath, focusFile) {
  const resolved = path.resolve(scriptPath);
  const timeout = parseInt(process.env.ELV_TIMEOUT, 10) || DEFAULT_TIMEOUT_MS;

  const env = Object.assign({}, process.env);
  if (focusFile) env.ELV_FOCUS_FILE = focusFile;

  const child = fork(path.join(__dirname, 'runner.js'), [resolved], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: env,
  });

  let events = null;
  let lastPendingTimers = 0;
  const timer = setTimeout(() => {
    const hint = lastPendingTimers > 0
      ? ' (' + lastPendingTimers + ' timer' + (lastPendingTimers > 1 ? 's' : '') + ' still pending)'
      : '';
    process.stderr.write(
      'Timeout: script did not complete within ' + timeout + 'ms' + hint + '.\n' +
      'Hint: Set ELV_TIMEOUT=60000 for longer scripts.\n'
    );
    child.kill();
    process.exit(1);
  }, timeout);

  child.on('message', (msg) => {
    if (msg && msg.type === 'events') {
      events = msg.data;
    }
    if (msg && msg.type === 'state') {
      lastPendingTimers = msg.pendingTimers || 0;
    }
  });

  child.on('exit', () => {
    clearTimeout(timer);
    if (!events || events.length === 0) {
      process.stderr.write('No events captured.\n');
      process.exit(1);
    }
    launchTUI(events, resolved, focusFile);
  });
}

/**
 * Tries to resolve a test file from --testPathPatterns or a file-like argument.
 * @param {string[]} runnerArgs - Args passed after `jest` or `vitest`
 * @returns {string | null}
 */
function autoDetectFocusFromArgs(runnerArgs) {
  const patternIdx = runnerArgs.findIndex(a => a === '--testPathPatterns' || a === '--testPathPattern');
  const pattern = patternIdx !== -1 ? runnerArgs[patternIdx + 1] : null;

  const candidates = [];

  // Check if any argument looks like a file path
  for (const arg of runnerArgs) {
    if (arg.startsWith('-')) continue;
    if (/\.(js|ts|mjs|cjs|jsx|tsx)$/.test(arg)) {
      candidates.push(arg);
    }
  }

  // Also try the testPathPatterns value with common test extensions
  if (pattern) {
    const extensions = ['.spec.ts', '.spec.tsx', '.test.ts', '.test.tsx', '.spec.js', '.test.js', '.ts', '.js'];
    for (const ext of extensions) {
      candidates.push(pattern.endsWith(ext) ? pattern : pattern + ext);
    }
  }

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    try {
      fs.accessSync(resolved, fs.constants.R_OK);
      return fs.realpathSync(resolved);
    } catch (_) {}
  }

  return null;
}

/**
 * Try to find a source file path from the command string (e.g. "npx vitest run src/utils.test.ts").
 * @param {string} command
 * @returns {string | null}
 */
function guessSourceFromCommand(command) {
  const tokens = command.split(/\s+/);
  for (const token of tokens) {
    if (/\.(js|ts|mjs|cjs|jsx|tsx)$/.test(token) && !token.startsWith('-')) {
      const resolved = path.resolve(token);
      try {
        fs.accessSync(resolved, fs.constants.R_OK);
        return resolved;
      } catch (_) {}
    }
  }

  return null;
}

/**
 * Spawn a shell command with instrumentation env vars, collect event files, and launch the TUI.
 * @param {string} command
 * @param {string | null} focusFile
 * @returns {void}
 */
function runCommandMode(command, focusFile) {
  const tmpDir = path.join(os.tmpdir(), 'elv-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(tmpDir, { recursive: true });

  const preloadPath = path.join(__dirname, 'preload.js');
  const jestEnvPath = path.join(__dirname, 'jest-environment.js');

  let effectiveCmd = command;
  const isVitest = /\bvitest\b/i.test(command);
  const isJest = /\bjest\b/i.test(command);
  const isNxTest = /\bnx\b.*\btest\b/i.test(command) || /:\s*test\b/.test(command);
  const looksLikeTest = isJest || isVitest || isNxTest;

  let elvVitestConfig = null;
  if (isVitest && !command.includes('--config')) {
    const vitestSetupPath = escapeForJS(path.join(__dirname, 'vitest-setup.mjs'));
    const pluginPath = escapeForJS(path.join(__dirname, 'vite-plugin-elv.mjs'));
    const elvSrcDir = escapeForJS(__dirname);
    const focusLiteral = focusFile ? "'" + escapeForJS(focusFile) + "'" : 'null';

    const configCandidates = [
      'vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs',
      'vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs',
    ];
    const userConfigFile = configCandidates.find(f => fs.existsSync(path.join(process.cwd(), f)));

    const lines = [
      "import { elvTransformPlugin } from '" + pluginPath + "';",
    ];
    if (userConfigFile) {
      lines.push("import userConfigDefault from './" + userConfigFile + "';");
      lines.push('');
      lines.push('const _raw = typeof userConfigDefault === "function" ? userConfigDefault() : userConfigDefault;');
      lines.push('const base = (_raw && _raw.default) || _raw || {};');
    } else {
      lines.push('');
      lines.push('const base = {};');
    }
    lines.push(
      'const baseTest = (base && base.test) || {};',
      'const baseSetup = Array.isArray(baseTest.setupFiles) ? baseTest.setupFiles : (baseTest.setupFiles ? [baseTest.setupFiles] : []);',
      'const baseServer = (base && base.server) || {};',
      'const baseFsAllow = (baseServer.fs && baseServer.fs.allow) || [];',
      '',
      'export default {',
      '  ...base,',
      "  server: { ...baseServer, fs: { ...(baseServer.fs || {}), allow: [...baseFsAllow, '" + elvSrcDir + "'] } },",
      "  plugins: [...(base.plugins || []), elvTransformPlugin({ focusFile: " + focusLiteral + " })],",
      '  test: {',
      '    ...baseTest,',
      "    setupFiles: [...baseSetup, '" + vitestSetupPath + "'],",
      '  },',
      '};',
      '',
    );
    elvVitestConfig = path.join(process.cwd(), '.elv-vitest.config.mjs');
    fs.writeFileSync(elvVitestConfig, lines.join('\n'));
    effectiveCmd += ' --config ' + shellEscape(elvVitestConfig);
  }

  if (elvVitestConfig) {
    const configToClean = elvVitestConfig;
    const cleanupConfig = () => { try { fs.unlinkSync(configToClean); } catch (_) {} };
    process.on('exit', cleanupConfig);
    process.on('SIGINT', () => { cleanupConfig(); process.exit(130); });
    process.on('SIGTERM', () => { cleanupConfig(); process.exit(143); });
  }

  if (isJest && !command.includes('--testEnvironment')) {
    effectiveCmd += ' --testEnvironment=' + jestEnvPath;
  } else if (isNxTest && !command.includes('--testEnvironment')) {
    if (effectiveCmd.includes(' -- ')) {
      effectiveCmd = effectiveCmd.replace(' -- ', ' -- --testEnvironment=' + jestEnvPath + ' ');
    } else {
      effectiveCmd += ' -- --testEnvironment=' + jestEnvPath;
    }
  }

  // Disable Jest coverage to prevent Istanbul from inflating line numbers
  if ((isJest || isNxTest) && !command.includes('--coverage')) {
    if (effectiveCmd.includes(' -- ')) {
      effectiveCmd = effectiveCmd.replace(' -- ', ' -- --coverage=false ');
    } else {
      effectiveCmd += ' --coverage=false';
    }
  }

  const existingNodeOptions = process.env.NODE_OPTIONS || '';
  const nodeOptions = (existingNodeOptions + ' --require ' + preloadPath).trim();

  const env = Object.assign({}, process.env, {
    NODE_OPTIONS: nodeOptions,
    ELV_OUTPUT_DIR: tmpDir,
    NX_DAEMON: 'false',
  });
  if (focusFile) env.ELV_FOCUS_FILE = focusFile;

  const child = spawn('sh', ['-c', effectiveCmd], {
    env: env,
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    let allEvents = [];
    try {
      const files = fs.readdirSync(tmpDir).filter(filename => filename.startsWith(EVENT_FILE_PREFIX) && filename.endsWith('.json'));
      for (const filename of files) {
        try {
          const raw = fs.readFileSync(path.join(tmpDir, filename), 'utf8');
          allEvents.push(JSON.parse(raw));
        } catch (_) { /* skip malformed */ }
      }
    } catch (_) { /* tmpDir may not exist */ }

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    if (elvVitestConfig) {
      try { fs.unlinkSync(elvVitestConfig); } catch (_) {}
    }

    if (allEvents.length === 0) {
      process.stderr.write('No events captured from command.\n');
      process.exit(code || 1);
    }

    // For test commands, prefer test worker events over parent process noise
    if (looksLikeTest) {
      const testWorkerEvents = allEvents.filter(processData =>
        processData.label === 'jest-worker' || processData.label === 'vitest'
      );
      if (testWorkerEvents.length > 0) {
        allEvents = testWorkerEvents;
      }
    }

    const guessedSource = guessSourceFromCommand(command);

    if (allEvents.length === 1) {
      launchTUI(allEvents[0].events, guessedSource, focusFile);
      return;
    }

    // Sort by event count descending so the richest process is listed first
    allEvents.sort((a, b) => (b.events ? b.events.length : 0) - (a.events ? a.events.length : 0));

    // Multiple processes — let user pick
    if (!process.stdin.isTTY) {
      launchTUI(allEvents[0].events, guessedSource, focusFile);
      return;
    }

    process.stdout.write('\nCaptured events from ' + allEvents.length + ' processes:\n\n');
    allEvents.forEach((processData, i) => {
      const label = classifyProcess(processData.argv, processData.label);
      const count = processData.events ? processData.events.length : 0;
      process.stdout.write(
        '  ' + (i + 1) + '. ' + label + ' (pid ' + processData.pid + ', ' + count + ' events)\n'
      );
    });
    process.stdout.write('\nSelect process [1-' + allEvents.length + ']: ');

    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
      const choice = parseInt(data.trim(), 10);
      if (choice >= 1 && choice <= allEvents.length) {
        launchTUI(allEvents[choice - 1].events, guessedSource, focusFile);
      } else {
        process.stderr.write('Invalid selection.\n');
        process.exit(1);
      }
    });
  });
}

/**
 * Scans events for the most frequently referenced user-code file.
 * Used as a fallback when no source path can be guessed from the command.
 * @param {ElvEvent[]} events
 * @returns {string | null}
 */
function extractSourceFromEvents(events) {
  const counts = new Map();
  for (const event of events) {
    if (!event.file) continue;
    if (event.file.includes('node_modules')) continue;
    counts.set(event.file, (counts.get(event.file) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [file, count] of counts) {
    if (count > bestCount) {
      best = file;
      bestCount = count;
    }
  }
  return best;
}

/**
 * @param {ElvEvent[]} events
 * @param {string | null} sourcePath
 * @param {string | null} focusFile
 * @returns {Promise<void>}
 */
async function launchTUI(events, sourcePath, focusFile) {
  const { startTUI } = await import('./ui.mjs');
  const effectiveSource = sourcePath || extractSourceFromEvents(events);
  const primaryPath = focusFile || (effectiveSource ? path.resolve(effectiveSource) : null);
  let source = null;
  if (primaryPath) {
    try {
      source = fs.readFileSync(primaryPath, 'utf8');
    } catch (_) {}
  }

  startTUI(events, source, primaryPath, focusFile);
}

module.exports = { main };
