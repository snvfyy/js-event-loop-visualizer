/**
 * Vite plugin that applies elv's source transform to user code.
 * Injects __elvTrack() calls for variable tracking (MEMORY events).
 *
 * Uses MagicString for source-map-preserving insertions so that line
 * numbers in the TUI match the original source, even after injecting
 * the guard and __elvTrack calls.
 *
 * Used in the auto-generated wrapper config when running `elv vitest ...`.
 * Runs after Vite's core transforms (TS/JSX → JS), so acorn can parse
 * the output cleanly.
 */
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const { getTransformInsertions } = _require('./transform.js');

let MagicString;
try {
  const vitePath = _require.resolve('vite');
  const viteRequire = createRequire(vitePath);
  MagicString = viteRequire('magic-string').default || viteRequire('magic-string');
} catch {
  MagicString = _require('magic-string');
}

const OWN_DIR = new URL('.', import.meta.url).pathname;

const ELV_TRACK_GUARD = 'if(typeof globalThis.__elvTrack==="undefined"){globalThis.__elvTrack=function(){};globalThis.__elvStep=function(){}}';

/**
 * @param {{ focusFile?: string | null }} [opts]
 * @returns {import('vite').Plugin}
 */
export function elvTransformPlugin(opts) {
  const focusFile = (opts && opts.focusFile) || null;

  return {
    name: 'elv-transform',
    transform(code, id) {
      if (id.includes('node_modules')) return null;
      if (id.startsWith(OWN_DIR)) return null;
      if (!/\.[mc]?[jt]sx?$/.test(id)) return null;

      if (focusFile && id !== focusFile && !id.endsWith('/' + focusFile)) return null;

      try {
        const result = getTransformInsertions(code, id);
        if (!result) return null;

        const s = new MagicString(code);

        for (const ins of result.insertions) {
          s.appendRight(ins.pos, ins.text);
        }

        s.prepend(ELV_TRACK_GUARD + '\n');

        return {
          code: s.toString(),
          map: s.generateMap({ hires: true }),
        };
      } catch (_) {
        return null;
      }
    },
  };
}
