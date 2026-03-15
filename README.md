# Event Loop Visualizer (`elv`)

**Step through JavaScript execution one event at a time.**

See how the call stack, microtask queue, macrotask queue, and variables change at each step — in your terminal.

```
┌────────────────── Header ───────────────────┐
│ Step 5/17   Phase: Microtasks   ▶ Playing   │
├─── Source Code ──┬─── Call Stack ───────────┤
│  1  console.log  │ ▶ Promise.then(fn)       │
│ [2  setTimeout]  ├── Micro Q ──┬─ Macro Q ──┤
│  3  ...          │ (empty)     │ 1. set...  │
├── Console Out ───┼─── Event Log ────────────┤
│ > start          │ ▶ Script started         │
│ > end            │ [T] → setTimeout(fn, 0)  │
├── Memory ────────┤                          │
│ count = 3        │ +1ms ▶ fn()              │
│ result = "ok"    │ +2ms [M] → .then(cb)     │
├─────────────────────────────────────────────┤
│ ←/→ Step ↑/↓ Scroll Tab Focus Space Play    │
└─────────────────────────────────────────────┘
```

![demo](demo.gif)

---

## 💡 Why?

There are great online event loop visualizers out there, but they all run in a sandbox with toy snippets. `elv` runs against **your actual code**.

---

## 📦 Install

```bash
# Globally
npm install -g event-loop-visualizer

# As a dev dependency
npm install -D event-loop-visualizer

# Without installing
npx event-loop-visualizer examples/async-await.js
```

---

## 🚀 Usage

### Standalone scripts

```bash
elv script.js
```

### Jest and Vitest tests

```bash
elv jest --testPathPatterns MyTest
elv vitest run src/utils.test.ts
```

Each `it()` / `test()` block gets a visual boundary — use `n` / `N` to jump between tests.

### Any command

```bash
elv --cmd "node server.js"
elv --cmd "pnpm nx run my-project:test --skip-nx-cache"
```

### Focus mode

Narrow capture to a single file. Only events originating from (or passing through) the focused file are recorded:

```bash
elv script.js --focus src/services/auth.js
elv jest --testPathPatterns MyTest --focus src/__tests__/MyTest.spec.ts
```

---

## 🎮 TUI Controls


| Key         | Action                        |
| ----------- | ----------------------------- |
| `→` / `l`   | Step forward                  |
| `←` / `h`   | Step backward                 |
| `↑` / `k`   | Scroll focused panel up       |
| `↓` / `j`   | Scroll focused panel down     |
| `Tab`       | Cycle focus to next panel     |
| `Shift+Tab` | Cycle focus to previous panel |
| `Space`     | Toggle auto-play              |
| `+` / `=`   | Speed up (min 100ms)          |
| `-` / `_`   | Slow down (max 3000ms)        |
| `n`         | Jump to next test             |
| `N`         | Jump to previous test         |
| `r`         | Reset to beginning            |
| `q` / `Esc` | Quit                          |


---

## 📂 Examples

The `examples/` directory has scripts covering core event loop concepts. Run any of them and step through interactively:

```bash
elv examples/async-await.js
elv examples/closure-loop.js
elv examples/nested-async.js
elv examples/promise-executor.js
```

---

## ⚠️ Limitations


| Limitation                      | Details                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pending promise timing**      | `.then(fn)` on a pending promise shows `fn` entering the queue immediately. In reality it's enqueued on resolve. Execution order is still correct. |
| **Jest fake timers**            | `jest.useFakeTimers()` replaces timers after elv's patches — timer events won't be captured. Promise + variable tracking still work.               |
| **TypeScript/JSX in file mode** | `elv script.ts` is not supported — TypeScript and JSX require a build step. Use `elv vitest run` or `elv jest` which handle TS/JSX natively.       |
| **TypeScript line numbers**     | In test mode, line numbers come from compiled JS. Minimal type annotations match perfectly; heavy generics/decorators may drift slightly.          |
| **setInterval cap**             | Capped at 10 iterations to prevent infinite events. Configurable via `ELV_INTERVAL_CAP`.                                                           |
| **Event cap**                   | 5000 events per process. Beyond this, a warning is shown. Configurable via `ELV_MAX_EVENTS`.                                                       |
| **Worker threads**              | `worker_threads` don't inherit `NODE_OPTIONS` — code in workers won't be instrumented.                                                             |
| **ESM in command mode**         | `.mjs` files loaded via `--cmd` aren't transformed (only `.js` and `.cjs` are hooked via `require`). Vitest/Jest modes handle ESM natively.        |
| **Windows**                     | Command mode uses `sh -c` which requires a POSIX shell. On Windows, use WSL or Git Bash.                                                           |
| **Bun / Deno**                  | Only Node.js is supported.                                                                                                                         |


---

## ⚙️ Environment Variables


| Variable           | Default | Description                                           |
| ------------------ | ------- | ----------------------------------------------------- |
| `ELV_TIMEOUT`      | `30000` | Safety timeout in ms for the `elv <script>` file mode |
| `ELV_MAX_EVENTS`   | `5000`  | Max events per process before capture stops           |
| `ELV_INTERVAL_CAP` | `10`    | Max `setInterval` iterations to record per interval   |


---

## 🔍 How It Works

`elv` instruments your code using three layers:

1. **AST transform** — Acorn parses your source and injects `__elvTrack()` / `__elvStep()` calls after variable mutations and function calls, enabling the Memory and Sync Step panels.
2. **Global patching** — `setTimeout`, `setInterval`, `queueMicrotask`, `process.nextTick`, `Promise.prototype.then/catch`, and `console.`* are monkey-patched to emit events when callbacks are enqueued and executed.
3. **async_hooks** — Node's `async_hooks` API tracks native `await` / `Promise` continuations that don't go through `.then()` directly.

Events are collected into a JSON array, then replayed step-by-step in the ink TUI.

> **Note:** `async_hooks` is stability 1 (experimental) in Node.js. Promise tracking behavior may differ slightly across Node 18, 20, and 22. `elv` is tested against Node 18+ and works best with Node 20 or 22.

---

## 🟢 Compatibility

### Node.js


| Version   | Status                                                                   |
| --------- | ------------------------------------------------------------------------ |
| Node 22   | Recommended. Full support.                                               |
| Node 20   | Full support.                                                            |
| Node 18   | Supported. Some `async_hooks` edge cases may produce extra/fewer events. |
| Node < 18 | Not supported.                                                           |


### Test Runners


| Tool   | Versions | Notes                                              |
| ------ | -------- | -------------------------------------------------- |
| Vitest | 1.x+     | Tested with 4.x. Vitest 4 requires Node 20+.       |
| Jest   | 30+      | Uses `vm.compileFunction` (introduced in Jest 30). |


### Vite


| Version  | Status                                                 |
| -------- | ------------------------------------------------------ |
| Vite 6+  | Supported (via Vitest 4 peer dependency).              |
| Vite 2–5 | The plugin API is compatible, but not actively tested. |


---

## 🤝 Contributing

Contributions are welcome! Check out the [Contributing Guide](CONTRIBUTING.md) for setup instructions, project structure, and PR guidelines.

---

**MIT License** · by [Snvfyy](https://github.com/snvfyy)