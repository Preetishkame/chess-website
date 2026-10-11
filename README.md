# Chess Arena

A Flask chess dashboard with python-chess rule validation, three local bot levels, local two-player games, Socket.IO rooms, and account/stat storage. SQLite is used automatically for local development; set `DATABASE_URL` to use PostgreSQL.

## Run on Windows

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
python app.py
```

In `.env`, replace the placeholder `SECRET_KEY` with a unique random value; set `DATABASE_URL` only when you have a PostgreSQL database. The app loads `.env` automatically. Open http://127.0.0.1:5000. The database is created as `chess_arena.db` locally. Registration requires a username (3–24 letters, numbers, or underscores) and password of at least 10 characters.

## Render deployment

Create a PostgreSQL database and set `DATABASE_URL` and a strong random `SECRET_KEY` in the Render service environment. Set `COOKIE_SECURE=1`. The included Render blueprint uses `gunicorn --worker-class gthread --workers 1 --threads 100 app:app` with Flask-SocketIO's threading mode. Keep one worker unless a shared message queue and shared room state are configured. Flask-SocketIO room state is in memory and is lost on restart.

## Implemented endpoints

- `GET /api/health`, `GET /api/status`
- `POST /api/games`, `GET /api/games/<id>`, `POST /api/games/<id>/move`, `/undo`, `/bot`, `/finish`
- `POST /api/register`, `/api/login`, `/api/logout`; `GET /api/me`, `/api/history`, `/api/leaderboard`
- Socket.IO `room_create`, `room_join`, `room_move` events

Chess rules (including castling, en passant, promotion, repetition and draw checks) come from python-chess. Bot levels use random legal moves (Easy), one-ply evaluation (Medium), and alpha-beta search (Hard). PostgreSQL features require a reachable PostgreSQL database; SQLite is available offline. Online rooms require Flask-SocketIO and the browser Socket.IO client. The leaderboard and profile stats use completed results saved by signed-in users.
