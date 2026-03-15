# Event Loop Visualizer (`js-elv`)

**Step through JavaScript execution one event at a time.**

See how the call stack, microtask queue, macrotask queue, and variables change at each step, in your terminal.

![demo](demo.gif)

## Table of Contents

- [Why?](#-why)
- [Installation](#-installation)
- [Usage](#-usage)
- [TUI Controls](#-tui-controls)
- [How It Works](#-how-it-works)
- [Compatibility](#-compatibility)
- [Limitations](#%EF%B8%8F-limitations)
- [Environment Variables](#%EF%B8%8F-environment-variables)
- [Issues](#-issues)
- [Contributing](#-contributing)
- [License](#-license)

---

## 💡 Why?

There are great online event loop visualizers out there, but they all run in a sandbox with toy snippets. `js-elv` runs against **your actual code**.

- **Debug real async bugs**: step through your actual `setTimeout`, `Promise`, and `await` chains to see exactly when callbacks fire and in what order.
- **Learn by seeing**: watch how microtasks drain before macrotasks, why `await` yields, and how closures capture variables, all in a live terminal UI.

---

## 📦 Installation

```bash
npm install -g js-elv
```

```bash
npm install -D js-elv
```

```bash
npx js-elv examples/async-await.js
```

---

## 🚀 Usage

### Standalone scripts

```bash
js-elv script.js
```

### Jest and Vitest tests

```bash
js-elv jest --testPathPatterns MyTest
js-elv vitest run src/utils.test.ts
```

Each `it()` / `test()` block gets a visual boundary. Use `n` / `N` to jump between tests.

### Any command

```bash
js-elv --cmd "node server.js"
js-elv --cmd "pnpm nx run my-project:test --skip-nx-cache"
```

### Focus mode

Narrow capture to a single file. Only events originating from (or passing through) the focused file are recorded:

```bash
js-elv script.js --focus src/services/auth.js
js-elv jest --testPathPatterns MyTest --focus src/__tests__/MyTest.spec.ts
```

### Examples

The `examples/` directory has scripts covering core event loop concepts. Run any of them and step through interactively:

```bash
js-elv examples/async-await.js
js-elv examples/closure-loop.js
js-elv examples/nested-async.js
js-elv examples/promise-executor.js
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

## 🔍 How It Works

`js-elv` instruments your code using three layers:

1. **AST transform**: Acorn parses your source and injects `__elvTrack()` / `__elvStep()` calls after variable mutations and function calls, enabling the Memory and Sync Step panels.
2. **Global patching**: `setTimeout`, `setInterval`, `queueMicrotask`, `process.nextTick`, `Promise.prototype.then/catch`, and `console.`* are monkey-patched to emit events when callbacks are enqueued and executed.
3. **async_hooks**: Node's `async_hooks` API tracks native `await` / `Promise` continuations that don't go through `.then()` directly.

Events are collected into a JSON array, then replayed step-by-step in the ink TUI.

---

## 🟢 Compatibility

**Node.js**  


| Version   | Status                                                                   |
| --------- | ------------------------------------------------------------------------ |
| Node 22   | Recommended. Full support.                                               |
| Node 20   | Full support.                                                            |
| Node 18   | Supported. Some `async_hooks` edge cases may produce extra/fewer events. |
| Node < 18 | Not supported.                                                           |


**Test Runners**  


| Tool   | Versions | Notes                                              |
| ------ | -------- | -------------------------------------------------- |
| Vitest | 1.x+     | Tested with 4.x. Vitest 4 requires Node 20+.       |
| Jest   | 30+      | Uses `vm.compileFunction` (introduced in Jest 30). |


**Vite**  


| Version  | Status                                                 |
| -------- | ------------------------------------------------------ |
| Vite 6+  | Supported (via Vitest 4 peer dependency).              |
| Vite 2–5 | The plugin API is compatible, but not actively tested. |


---

## ⚠️ Limitations

Known limitations and edge cases  


| Limitation                 | Details                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pending promise timing** | `.then(fn)` on a pending promise shows `fn` entering the queue immediately. In reality it's enqueued on resolve. Execution order is still correct.                                                                                                                                                      |
| **Jest fake timers**       | `jest.useFakeTimers()` replaces timers after js-elv's patches. Timer events won't be captured. Promise + variable tracking still work.                                                                                                                                                                     |
| **TypeScript / JSX**       | Not natively supported. `js-elv script.ts` won't work. TS/JSX require a build step. Use `js-elv vitest run` or `js-elv jest` which handle TS/JSX via their own transforms. In test mode, line numbers come from compiled JS; minimal type annotations map correctly, but heavy generics or decorators may drift. |
| **setInterval cap**        | Capped at 10 iterations to prevent infinite events. Configurable via `ELV_INTERVAL_CAP`.                                                                                                                                                                                                                |
| **Event cap**              | 5000 events per process. Beyond this, a warning is shown. Configurable via `ELV_MAX_EVENTS`.                                                                                                                                                                                                            |
| **Worker threads**         | `worker_threads` don't inherit `NODE_OPTIONS`. Code in workers won't be instrumented.                                                                                                                                                                                                                   |
| **ESM in command mode**    | `.mjs` files loaded via `--cmd` aren't transformed (only `.js` and `.cjs` are hooked via `require`). Vitest/Jest modes handle ESM natively.                                                                                                                                                             |
| **Windows**                | Command mode uses `sh -c` which requires a POSIX shell. On Windows, use WSL or Git Bash.                                                                                                                                                                                                                |
| **Bun / Deno**             | Only Node.js is supported.                                                                                                                                                                                                                                                                              |


---

## ⚙️ Environment Variables


| Variable           | Default | Description                                           |
| ------------------ | ------- | ----------------------------------------------------- |
| `ELV_TIMEOUT`      | `30000` | Safety timeout in ms for the `js-elv <script>` file mode |
| `ELV_MAX_EVENTS`   | `5000`  | Max events per process before capture stops           |
| `ELV_INTERVAL_CAP` | `10`    | Max `setInterval` iterations to record per interval   |


---

## 🐛 Issues

### Bugs

**[See Bugs](https://github.com/snvfyy/js-event-loop-visualizer/issues?q=is%3Aissue+is%3Aopen+label%3Abug+sort%3Acreated-desc)**

### Feature Requests

**[See Feature Requests](https://github.com/snvfyy/js-event-loop-visualizer/issues?q=is%3Aissue+sort%3Areactions-%2B1-desc+label%3Aenhancement+is%3Aopen)**

---

## 🤝 Contributing

Contributions are welcome! Check out the [Contributing Guide](CONTRIBUTING.md).

---

## 📄 License

[MIT](LICENSE) · by [Snvfyy](https://github.com/snvfyy)