# Kill Tracker Overlay

An Alt1 Toolkit overlay that reads RuneScape chat to track boss kill counts, pets, drops, and clue scrolls. The overlay now supports authenticated sync so your stats persist across sessions.

## Hosted app

Use the public deployment at **https://jakepvg.com/alt-killtracker**.

Install directly into Alt1:

```
alt1://addapp/https://jakepvg.com/alt-killtracker/appconfig.json
```

You can also open the URL in a normal browser to test without Alt1.

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Run database migrations (PostgreSQL):

   ```bash
   npm run migrate
   ```

3. Start the server (defaults to port `8080`):

   ```bash
   npm start
   ```

Then open [http://localhost:8080](http://localhost:8080) in your browser or add the local appconfig to Alt1.

## API & authentication

The server exposes JSON endpoints under `/api`:

- `POST /api/register` – Create a user (body: `{ username, password }`).
- `POST /api/login` – Authenticate and receive a bearer token.
- `GET /api/stats` – Fetch the authenticated user's saved stats.
- `PUT /api/stats` – Persist stats for the authenticated user (body: `{ data }`).

Include `Authorization: Bearer <token>` on protected routes. Tokens are signed with `JWT_SECRET` and attach the user to `req` via middleware.

### Environment variables

- `PORT` – Express listen port (default `8080`).
- `DATABASE_URL` – Full PostgreSQL connection string. If set, overrides individual `PG*` values.
- `PGHOST` – PostgreSQL host (default `localhost`).
- `PGPORT` – PostgreSQL port (default `5432`).
- `PGDATABASE` – Database name (default `alt1-tracker`).
- `PGUSER` / `PGPASSWORD` – Database credentials.
- `JWT_SECRET` – Secret used to sign tokens.

### Data model

`migrate.js` creates two tables:

- `users` – `id`, `username` (unique), `password_hash`, `created_at`
- `stats` – `user_id` (PK + FK), `data` (JSONB), `updated_at`

Stats are keyed by user and stored as JSONB so the overlay's client state can round-trip without custom schema changes.

## Sync flow

On login or registration, the frontend saves the bearer token in `localStorage` and uses it in future fetches. When the overlay detects kills/drops or clue changes, it keeps the in-memory state authoritative and periodically syncs it to `/api/stats` so you can resume on other machines.

## License

Free to use or modify. Please credit if redistributed.
