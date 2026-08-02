# Repository Guidelines

## Project Structure & Module Organization

The app entry point is `src/main.js`; it creates the MapLibre map and its Hype vector-tile style. Global styles live in `src/style.css`. `index.html` holds the single map container, and production files are generated in `dist/` (do not edit or commit them). Keep new source code in `src/` and configuration at the repository root. Avoid committing local environment files such as `.env`.

## Build, Test, and Development Commands

Use Bun for the project:

- `bun install` installs dependencies.
- `bun run dev` starts Vite's local development server.
- `bun run build` produces a production bundle in `dist/`.
- `bun run preview` serves the production bundle locally.

Document any added command in `README.md` and keep it in `package.json`.

## Coding Style & Naming Conventions

Use 2-space indentation and semicolon-free JavaScript, matching `src/main.js`. Name files and directories in `kebab-case`; use `camelCase` for functions and variables and `PascalCase` for classes or UI components. Keep map configuration explicit and use `https://tiles.hype.hk/basemap/hongkong-latest.json` for the Hong Kong vector source unless the map service changes.

## Testing Guidelines

There is no automated test suite yet. At minimum, run `bun run build` before opening a pull request and manually verify map loading, zoom, pan, and navigation controls with `bun run dev`. When adding tests, use a focused framework and name files `*.test.js`.

## Commit & Pull Request Guidelines

There is no commit history yet, so use concise imperative commit subjects, optionally following Conventional Commits: `feat: add place markers` or `fix: keep map in bounds`. Keep commits single-purpose. Pull requests should explain the change, list validation performed, link relevant issues, and include screenshots for visible map changes. Do not include `dist/` or unrelated formatting.

## Security & Configuration

Never commit credentials, API keys, or real `.env` files. Provide safe placeholders through `.env.example`, and document required configuration values in the README.
