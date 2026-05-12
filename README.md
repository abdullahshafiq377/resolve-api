# resolve-api

Node.js + Express + MongoDB (Mongoose) API.

## Setup

```bash
npm install
cp .env.example .env   # edit values
npm run dev            # nodemon
npm start              # production
```

## Structure

```
src/
  server.js        entry: load env, connect DB, start server
  app.js           express app, middleware, error handling
  config/db.js     mongoose connection
  routes/          route definitions
  models/          mongoose schemas
```

## Endpoints

- `GET /health` — service health
- `GET /api` — API root
