# Supreme FPL Hub — corrected live version

This version is a real web app, not a `file://` HTML page.

## Architecture

Browser → Express backend → official public FPL API

The backend:
- keeps FPL requests off the phone/browser
- caches common responses
- follows H2H pagination
- exposes clean `/api/*` routes
- serves the frontend from the same origin, so the browser has no cross-origin FPL request

## Run locally

Install Node.js 20+.

```bash
npm install
npm start
```

Then open:

`http://localhost:3000`

Do **not** open `public/index.html` directly.

## Deploy

This project is ready for a Node hosting service such as Render, Railway, Fly.io, or a VPS.

Build command:
```bash
npm install
```

Start command:
```bash
npm start
```

No database or environment variables are required for the public FPL data layer.

## API routes

- `GET /api/health`
- `GET /api/bootstrap`
- `GET /api/fixtures`
- `GET /api/live/:gw`
- `GET /api/entry/:id`
- `GET /api/entry/:id/history`
- `GET /api/h2h/:id`
- `POST /api/histories`

## Carabao rules implemented

- Round 1: positions 13–20 after GW8, paired 13v20, 14v19, 15v18, 16v17.
- Round 1 result: normal FPL points in GW9.
- Round of 16: GW15 FPL points.
- Quarterfinal: GW24 FPL points.
- Semifinal: GW29 FPL points.
- Final: GW35 FPL points.
- A tie is resolved by the better pre-round H2H seed.
- The cup engine does not use the H2H weekly result to decide a cup tie.

The exact later-round bracket is generated deterministically from the locked Round 1 bracket, so it does not depend on browser state.

## Important

The FPL API is public but undocumented and its response shapes can change. The app uses defensive parsing and server-side caching.
