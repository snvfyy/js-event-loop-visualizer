# Contributing to Event Loop Visualizer

Thanks for your interest in contributing! This guide will help you get started.

## Code of Conduct

Be respectful and constructive. Harassment or abusive behavior won't be tolerated.

## How to Contribute

### Reporting Bugs

Open an [issue](https://github.com/snvfyy/js-event-loop-visualizer/issues) with:

- A clear title and description
- Steps to reproduce the bug
- Expected vs actual behavior
- Node.js version (`node -v`) and OS
- The script or test command you ran (if applicable)

### Suggesting Features

Open an issue with the **feature request** label. Describe:

- The problem you're trying to solve
- How you envision the solution
- Any alternatives you've considered

### Pull Requests

1. **Fork** the repository
2. **Clone** your fork locally:
  ```bash
   git clone https://github.com/<your-username>/js-event-loop-visualizer.git
   cd js-event-loop-visualizer
  ```
3. **Install** dependencies:
  ```bash
   npm install
  ```
4. **Create a branch** from `main`:
  ```bash
   git switch -c my-feature
  ```
5. **Make your changes** — see the [development guide](#development) below
6. **Test** your changes:
  ```bash
   npx vitest run
  ```
7. **Commit** with a clear message (see [commit guidelines](#commit-messages))
8. **Push** to your fork and open a Pull Request against `main`

## Development

### Project Structure

```
bin/
  elv.js
src/
  cli.js
  instrument.js
  runner.js
  transform.js
  classify.js
  ui.mjs
  write-events.js
  preload.js
  jest-environment.js
  vitest-environment.mjs
  vitest-setup.mjs
  vite-plugin-elv.mjs
  types.js
tests/
  classify.test.js
  transform.test.js
  event-capture.test.js
  tui-rendering.test.js
  ui.test.js
  serialize.test.js
examples/
```

### Running Tests

```bash
# Run the full test suite
npm test

# Run tests in watch mode during development
npm run test:watch

# Run a specific test file
npx vitest run tests/transform.test.js
```

The test suite includes:

- **Unit tests** (`classify.test.js`, `serialize.test.js`) — pure function tests for classification and serialization
- **Transform tests** (`transform.test.js`) — tests for AST-based source transformation
- **State logic tests** (`ui.test.js`) — unit tests for `applyEvent`, `createInitialState`, and `pathsMatch`
- **TUI rendering tests** (`tui-rendering.test.js`) — ink component rendering with simulated keyboard interaction
- **Integration tests** (`event-capture.test.js`) — forks `runner.js` with example scripts and asserts on the captured event stream

### Running Examples Manually

```bash
# Run an example to verify your changes visually
node bin/elv.js examples/async-await.js

# Run another example
node bin/elv.js examples/nested-async.js
```

### Requirements

- **Node.js** >= 18.0.0
- No build step — the project uses plain JavaScript with JSDoc types

### ESM / CJS Boundary

The project uses **CJS** (`.js`) for most files and **ESM** (`.mjs`) for `ui.mjs` and the three Vitest integration files:
- `vitest-environment.mjs` — Custom Vitest test environment
- `vitest-setup.mjs` — Vitest `beforeEach`/`afterEach` hooks for test boundaries
- `vite-plugin-elv.mjs` — Vite plugin for source-map-preserving transforms

Vitest requires ESM for its environment and setup APIs. These `.mjs` files use `createRequire(import.meta.url)` to bridge back to the CJS modules (`instrument.js`, `transform.js`, `write-events.js`). When adding new shared utilities, write them as CJS and import via `createRequire` from ESM files.

### Key Dependencies

- **acorn / acorn-walk** — AST parsing for source code extraction
- **ink / react / chalk** — Terminal UI rendering
- **magic-string** — Source-map-preserving string manipulation (resolved from Vite's own dependencies at runtime; only used in `vite-plugin-elv.mjs`)

## Commit Messages

Use clear, concise commit messages:

- `fix: prevent duplicate events when using async/await`
- `feat: add support for setImmediate tracking`
- `docs: clarify focus mode usage in README`
- `refactor: simplify event deduplication logic`

Format: `<type>: <short description>`

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Make sure all tests pass (`npm test`)
- Add tests for new functionality when possible
- Update the README if your change affects user-facing behavior
- Add an example script in `examples/` if it helps demonstrate the change
- Make sure existing examples still work (`node bin/elv.js examples/async-await.js`)
- Describe **what** your PR does and **why** in the PR description

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).