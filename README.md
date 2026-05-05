# Path Builder

A small browser-based tool for plotting points on a map and exporting them as a CSV path. Click points on the map, set timestamps and titles, then download a `latitude,longitude,timestamp,type,title` CSV.

Built with [React](https://react.dev) + [Vite](https://vitejs.dev), using [Leaflet](https://leafletjs.com) for mapping (loaded from CDN at runtime — no API key required).

## Prerequisites

You need two things installed:

1. **Node.js** (LTS — version 20 or newer). Download from [nodejs.org](https://nodejs.org/) or use a version manager like [nvm](https://github.com/nvm-sh/nvm) / [fnm](https://github.com/Schniz/fnm).
2. **pnpm** — this project uses pnpm, not npm. The easiest way to get the right version is via [Corepack](https://nodejs.org/api/corepack.html), which ships with Node:

   ```sh
   corepack enable
   ```

   Corepack reads the `packageManager` field in `package.json` and uses the matching pnpm version automatically. (If you prefer, you can install pnpm globally instead: `npm install -g pnpm`.)

## Getting started

Clone the repo and install dependencies:

```sh
git clone https://github.com/lumyx-inc/path-builder.git
cd path-builder
pnpm install
```

Start the dev server:

```sh
pnpm dev
```

Vite will print a local URL (typically `http://localhost:5173`). Open it in a browser — the page hot-reloads as you edit files in `src/`.

## Troubleshooting

- **`pnpm: command not found`** — run `corepack enable`, or install pnpm with `npm install -g pnpm`.
- **Wrong pnpm version warning** — Corepack will prompt to download the version pinned in `package.json`. Accept it.
- **Map doesn't load** — Leaflet is loaded from a CDN at runtime; check that your network/firewall isn't blocking `cdnjs.cloudflare.com`.
