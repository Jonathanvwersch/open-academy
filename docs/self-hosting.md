# Self-hosting

Open Academy runs as one Node server with a Postgres database. Each instance is for one learner and is protected by a single password.

Settings for both options:

| Variable | Required | What it does |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. |
| `ACADEMY_PASSWORD` | yes | The sign-in password, at least 12 characters. The server won't start without it. |
| `OPENAI_API_KEY` | no | Turns on the tutor. Without it, everything else works. |
| `OPENAI_MODEL` | no | The tutor's model. |
| `TUTOR_DAILY_CALL_CAP` | no | Maximum tutor calls per day (default 200). |
| `CONTENT_DIR` | no | The course pack to load. Defaults to the demo pack in `content/`. |

Migrations run automatically, so there's no separate database step.

## Vercel and Neon

1. Click **Deploy with Vercel** in the README. Vercel copies the repository to your GitHub account and creates a project.
2. When it asks for `DATABASE_URL`, create a database at [neon.tech](https://neon.tech) and paste its connection string. Alternatively, add Neon from the project's **Storage** tab, which sets `DATABASE_URL` for you.
3. Set `ACADEMY_PASSWORD`, and `OPENAI_API_KEY` if you want the tutor.
4. Deploy. The build runs the migrations, so the database has to be reachable at build time. If Neon gives you a direct (unpooled) connection string as well, set it as `DATABASE_URL_UNPOOLED`, and migrations will use it.

To use your own course pack, commit the pack folder to your copy of the repository and set `CONTENT_DIR` to its path, for example `packs/organic-chemistry`. The pack is bundled at build time, so push to redeploy after editing it.

## Docker Compose

This works on any machine with Docker: a VPS, a home server, or your laptop.

```sh
git clone https://github.com/Jonathanvwersch/open-academy.git
cd open-academy
cp deploy/.env.example deploy/.env    # then set ACADEMY_PASSWORD (and OPENAI_API_KEY if you want the tutor)
docker compose -f deploy/docker-compose.yml up -d --build
```

Open http://localhost:3000 and sign in with your password. The database is kept in the `academy-postgres-data` volume, so it survives restarts and rebuilds.

To use your own course pack, uncomment the `volumes` and `CONTENT_DIR` lines in `deploy/docker-compose.yml` and point the volume at your pack folder:

```yaml
    environment:
      CONTENT_DIR: /pack
    volumes:
      - ../my-pack:/pack:ro
```

The pack is read when the server starts, so restart the app after editing it: `docker compose -f deploy/docker-compose.yml restart app`.

Put the app behind a reverse proxy with HTTPS (Caddy, nginx, or a Cloudflare tunnel) before you expose it to the internet. Without HTTPS, your password and sign-in cookie travel unencrypted.

## Switching packs

Progress is stored by topic ID. If you point one database at a different pack, topics that the new pack doesn't have are hidden, not deleted, so switching back restores them. Two packs that use the same topic ID would share progress for it, so give each pack its own database unless their IDs are distinct.

## Backups

Everything a learner has done is in Postgres. With Compose:

```sh
docker compose -f deploy/docker-compose.yml exec db pg_dump -U academy academy > academy-backup.sql
```

On Neon, use its point-in-time restore or run `pg_dump` against `DATABASE_URL`.
