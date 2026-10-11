"""Zero Period Chess: Flask application, API, and WebSocket multiplayer server."""
from __future__ import annotations

import logging
import os
import random
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

import chess
import chess.pgn
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

try:
    from flask_socketio import SocketIO, emit, join_room, leave_room
except ImportError:
    SocketIO = None

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()

app = Flask(__name__, template_folder=str(BASE_DIR / "templates"), static_folder=str(BASE_DIR / "static"))
app.config.update(
    SECRET_KEY=os.getenv("SECRET_KEY") or secrets.token_hex(32),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.getenv("COOKIE_SECURE", "0") == "1",
    MAX_CONTENT_LENGTH=1_000_000,
)

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("zero_period_chess")

cors_setting = os.getenv("CORS_ORIGINS", "").strip()
allowed_origins = [origin.strip() for origin in cors_setting.split(",") if origin.strip()] if cors_setting else "*"
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins=allowed_origins, manage_session=True) if SocketIO else None

# In-memory single-player games & multiplayer rooms
games: dict[str, chess.Board] = {}
bot_calculating: set[str] = set()
rooms: dict[str, dict] = {}
sid_to_room: dict[str, str] = {}
lock = threading.RLock()


# ── Database Layer ──────────────────────────────────────────────────────────

def db_connect():
    if DATABASE_URL:
        try:
            import psycopg
            return psycopg.connect(DATABASE_URL, autocommit=True), True
        except Exception as exc:
            raise RuntimeError("PostgreSQL is configured but unavailable. Check DATABASE_URL.") from exc
    path = os.getenv("SQLITE_PATH", str(BASE_DIR / "chess_arena.db"))
    connection = sqlite3.connect(path, timeout=10, isolation_level=None)
    connection.row_factory = sqlite3.Row
    return connection, False


def init_db():
    conn, pg = db_connect()
    try:
        serial = "BIGSERIAL PRIMARY KEY" if pg else "INTEGER PRIMARY KEY AUTOINCREMENT"
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS users ("
            f"id {serial}, "
            f"username TEXT UNIQUE NOT NULL, "
            f"password_hash TEXT NOT NULL, "
            f"created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        )
        conn.execute(
            f"CREATE TABLE IF NOT EXISTS completed_games ("
            f"id {serial}, "
            f"game_id TEXT, "
            f"user_id INTEGER, "
            f"result TEXT NOT NULL, "
            f"opponent TEXT NOT NULL, "
            f"pgn TEXT NOT NULL, "
            f"mode TEXT DEFAULT 'bot', "
            f"time_control TEXT DEFAULT '10 min', "
            f"termination TEXT DEFAULT 'Normal', "
            f"moves_count INTEGER DEFAULT 0, "
            f"created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        )

        if pg:
            for col, col_type in [("game_id", "TEXT"), ("mode", "TEXT DEFAULT 'bot'"),
                                  ("time_control", "TEXT DEFAULT '10 min'"), ("termination", "TEXT DEFAULT 'Normal'"),
                                  ("moves_count", "INTEGER DEFAULT 0")]:
                try:
                    conn.execute(f"ALTER TABLE completed_games ADD COLUMN IF NOT EXISTS {col} {col_type}")
                except Exception:
                    pass
        else:
            existing = {row[1] for row in conn.execute("PRAGMA table_info(completed_games)").fetchall()}
            for col, col_type in [("game_id", "TEXT"), ("mode", "TEXT DEFAULT 'bot'"),
                                  ("time_control", "TEXT DEFAULT '10 min'"), ("termination", "TEXT DEFAULT 'Normal'"),
                                  ("moves_count", "INTEGER DEFAULT 0")]:
                if col not in existing:
                    conn.execute(f"ALTER TABLE completed_games ADD COLUMN {col} {col_type}")

        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS completed_games_user_game ON completed_games(user_id, game_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS completed_games_user_id_idx ON completed_games(user_id)")
    finally:
        conn.close()


def current_user():
    return session.get("user_id")


def current_username():
    return session.get("username")


# ── Chess Helpers ────────────────────────────────────────────────────────────

def board_payload(board: chess.Board):
    replay = board.copy(stack=True)
    history = list(replay.move_stack)
    while replay.move_stack:
        replay.pop()
    san_moves = []
    for move in history:
        san_moves.append(replay.san(move))
        replay.push(move)
    last_move = history[-1].uci() if history else None

    # Calculate captured pieces by comparing starting pieces to current
    start_counts = {chess.PAWN: 8, chess.KNIGHT: 2, chess.BISHOP: 2, chess.ROOK: 2, chess.QUEEN: 1}
    white_captured = []
    black_captured = []
    for pt, count in start_counts.items():
        w_cur = len(board.pieces(pt, chess.WHITE))
        b_cur = len(board.pieces(pt, chess.BLACK))
        for _ in range(max(0, count - w_cur)):
            white_captured.append(chess.piece_symbol(pt).upper())
        for _ in range(max(0, count - b_cur)):
            black_captured.append(chess.piece_symbol(pt).lower())

    outcome = board.outcome(claim_draw=True) if board.is_game_over(claim_draw=True) else None
    return {
        "fen": board.fen(),
        "turn": "white" if board.turn else "black",
        "check": board.is_check(),
        "game_over": board.is_game_over(claim_draw=True),
        "result": board.result(claim_draw=True) if outcome else None,
        "status": outcome.termination.name.replace("_", " ").title() if outcome else None,
        "moves": san_moves,
        "legal_moves": [m.uci() for m in board.legal_moves],
        "last_move": last_move,
        "captured": {"white_lost": white_captured, "black_lost": black_captured}
    }


def board_pgn(board: chess.Board, result: str | None = None, termination: str | None = None, white: str = "White", black: str = "Black"):
    game = chess.pgn.Game.from_board(board)
    game.headers["Event"] = "Zero Period Chess Match"
    game.headers["White"] = white
    game.headers["Black"] = black
    if result:
        game.headers["Result"] = result
    if termination:
        game.headers["Termination"] = termination
    return game.accept(chess.pgn.StringExporter(headers=True, variations=False, comments=False))


def result_for_white(result: str | None):
    return {"1-0": "win", "0-1": "loss", "1/2-1/2": "draw"}.get(result)


def save_completed_game(game_id, user_id, result, opponent, pgn, mode="bot", time_control="10 min", termination="Normal", moves_count=0):
    if not user_id:
        return
    conn, pg = db_connect()
    try:
        sql = (
            "INSERT INTO completed_games (game_id, user_id, result, opponent, pgn, mode, time_control, termination, moves_count) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (user_id, game_id) DO NOTHING"
            if pg else
            "INSERT OR IGNORE INTO completed_games (game_id, user_id, result, opponent, pgn, mode, time_control, termination, moves_count) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        conn.execute(sql, (game_id, user_id, result, str(opponent)[:40], pgn, str(mode)[:20], str(time_control)[:20], str(termination)[:40], int(moves_count)))
    finally:
        conn.close()


# ── Advanced Bot Engine with Iterative Deepening & Thinking Budget ──────────

PIECE_VALUES = {
    chess.PAWN: 100,
    chess.KNIGHT: 320,
    chess.BISHOP: 335,
    chess.ROOK: 500,
    chess.QUEEN: 900,
    chess.KING: 20000
}

# Positional piece-square bonus tables (from White's perspective)
PAWN_TABLE = [
    0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0
]

KNIGHT_TABLE = [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
]

BISHOP_TABLE = [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
]


def evaluate_board(board: chess.Board) -> int:
    if board.is_checkmate():
        return -99999 if board.turn == chess.WHITE else 99999
    if board.is_stalemate() or board.is_insufficient_material() or board.can_claim_draw():
        return 0

    score = 0
    for square in chess.SQUARES:
        piece = board.piece_at(square)
        if not piece:
            continue
        val = PIECE_VALUES[piece.piece_type]
        sq_idx = square if piece.color == chess.WHITE else chess.square_mirror(square)
        pst = 0
        if piece.piece_type == chess.PAWN:
            pst = PAWN_TABLE[sq_idx]
        elif piece.piece_type == chess.KNIGHT:
            pst = KNIGHT_TABLE[sq_idx]
        elif piece.piece_type == chess.BISHOP:
            pst = BISHOP_TABLE[sq_idx]

        total = val + pst
        score += total if piece.color == chess.WHITE else -total

    # Mobility bonus
    score += (8 if board.turn == chess.WHITE else -8) * board.legal_moves.count()
    return score if board.turn == chess.WHITE else -score


def move_sort_key(board: chess.Board, move: chess.Move):
    score = 0
    if board.is_capture(move):
        victim = board.piece_at(move.to_square)
        attacker = board.piece_at(move.from_square)
        if victim and attacker:
            score += 10 * PIECE_VALUES[victim.piece_type] - PIECE_VALUES[attacker.piece_type]
        else:
            score += 100
    if move.promotion:
        score += 800
    if board.gives_check(move):
        score += 50
    return score


def search_iterative(board: chess.Board, max_depth: int, deadline: float):
    best_move = None
    legal_moves = list(board.legal_moves)
    if not legal_moves:
        return None
    if len(legal_moves) == 1:
        return legal_moves[0]

    def alphabeta(node: chess.Board, depth: int, alpha: int, beta: int):
        if time.monotonic() >= deadline:
            raise TimeoutError()
        if depth == 0 or node.is_game_over(claim_draw=True):
            return evaluate_board(node)

        moves = sorted(node.legal_moves, key=lambda m: move_sort_key(node, m), reverse=True)
        max_val = -float("inf")
        for m in moves:
            node.push(m)
            val = -alphabeta(node, depth - 1, -beta, -alpha)
            node.pop()
            max_val = max(max_val, val)
            alpha = max(alpha, val)
            if alpha >= beta:
                break
        return max_val

    # Iterative deepening from depth 1 up to max_depth
    for current_depth in range(1, max_depth + 1):
        if time.monotonic() >= deadline:
            break
        moves = sorted(legal_moves, key=lambda m: move_sort_key(board, m), reverse=True)
        current_best = None
        best_score = -float("inf")
        alpha = -float("inf")
        beta = float("inf")

        try:
            for m in moves:
                board.push(m)
                val = -alphabeta(board, current_depth - 1, -beta, -alpha)
                board.pop()
                if val > best_score:
                    best_score = val
                    current_best = m
                alpha = max(alpha, val)
            if current_best:
                best_move = current_best
        except TimeoutError:
            break

    return best_move or random.choice(legal_moves)


# ── Routes: Core & Information ──────────────────────────────────────────────

@app.get("/")
def home():
    response = app.make_response(render_template("index.html"))
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/health")
def health():
    return jsonify(status="ok", application="Zero Period Chess", database="postgresql" if DATABASE_URL else "sqlite")


@app.get("/api/status")
def status():
    return jsonify(
        name="Zero Period Chess",
        version="2.0.0",
        features={
            "legal_chess": True,
            "bot_thinking_time": True,
            "accounts": True,
            "game_history": True,
            "leaderboard": True,
            "database": "postgresql" if DATABASE_URL else "sqlite",
            "multiplayer": bool(socketio),
            "reconnection": True
        }
    )


# ── Single-Player Game Routes ───────────────────────────────────────────────

@app.post("/api/games")
def create_game():
    data = request.get_json(silent=True) or {}
    mode = data.get("mode", "bot")
    difficulty = data.get("difficulty", "medium")
    if mode not in ("bot", "local", "online") or difficulty not in ("easy", "medium", "hard"):
        return jsonify(error="Invalid game mode or difficulty."), 400
    game_id = secrets.token_urlsafe(12)
    with lock:
        games[game_id] = chess.Board()
    return jsonify(game_id=game_id, mode=mode, difficulty=difficulty, **board_payload(games[game_id]))


@app.get("/api/games/<game_id>")
def get_game(game_id):
    board = games.get(game_id)
    return (jsonify(error="Game not found."), 404) if board is None else jsonify(game_id=game_id, **board_payload(board))


@app.post("/api/games/<game_id>/move")
def make_move(game_id):
    data = request.get_json(silent=True) or {}
    uci = data.get("move", "")
    with lock:
        board = games.get(game_id)
        if board is None:
            return jsonify(error="Game not found."), 404
        try:
            move = chess.Move.from_uci(uci)
        except (ValueError, TypeError):
            return jsonify(error="Move must be valid UCI notation."), 400
        if board.is_game_over(claim_draw=True) or move not in board.legal_moves:
            return jsonify(error="That move is not legal."), 400
        san = board.san(move)
        board.push(move)
        state = board_payload(board)
    return jsonify(san=san, **state)


@app.post("/api/games/<game_id>/undo")
def undo_move(game_id):
    board = games.get(game_id)
    if board is None:
        return jsonify(error="Game not found."), 404
    with lock:
        if board.move_stack:
            board.pop()
        if board.move_stack:
            board.pop()
        return jsonify(**board_payload(board))


@app.post("/api/games/<game_id>/bot")
def bot_move(game_id):
    data = request.get_json(silent=True) or {}
    difficulty = data.get("difficulty", "medium")
    if difficulty not in ("easy", "medium", "hard"):
        return jsonify(error="Invalid difficulty."), 400

    start_time = time.monotonic()
    budgets = {
        "easy": (random.uniform(0.5, 0.9), 1),
        "medium": (random.uniform(1.2, 1.8), 3),
        "hard": (random.uniform(2.2, 3.4), 5)
    }
    target_time, max_depth = budgets[difficulty]
    deadline = start_time + target_time

    with lock:
        if game_id in bot_calculating:
            return jsonify(error="Bot is already calculating for this game."), 429
        board = games.get(game_id)
        if board is None:
            return jsonify(error="Game not found."), 404
        if board.is_game_over(claim_draw=True):
            return jsonify(error="Game is over."), 400
        if board.turn != chess.BLACK:
            return jsonify(error="It is not the bot's turn to move."), 400
        bot_calculating.add(game_id)
        # Create an isolated board copy for search
        search_board = board.copy(stack=True)

    try:
        if difficulty == "easy":
            # Easy bot: select from tactical moves with blunders
            moves = list(search_board.legal_moves)
            captures = [m for m in moves if search_board.is_capture(m)]
            chosen = random.choice(captures or moves) if random.random() < 0.4 else random.choice(moves)
        else:
            chosen = search_iterative(search_board, max_depth, deadline)
    finally:
        with lock:
            bot_calculating.discard(game_id)

    with lock:
        board = games.get(game_id)
        if board is None:
            return jsonify(error="Game was cancelled."), 404
        if board.is_game_over(claim_draw=True) or board.turn != chess.BLACK:
            return jsonify(error="Position changed during search."), 409
        if chosen not in board.legal_moves:
            chosen = random.choice(list(board.legal_moves))

        # Enforce target response time smoothly without blocking other threads
        elapsed = time.monotonic() - start_time
        remaining = target_time - elapsed
        if remaining > 0.05:
            time.sleep(remaining)

        san = board.san(chosen)
        board.push(chosen)
        return jsonify(san=san, **board_payload(board))


# ── Account, Profile, History, & Leaderboard ───────────────────────────────

@app.post("/api/register")
def register():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    if not re.fullmatch(r"[A-Za-z0-9_]{3,24}", username) or len(password) < 10:
        return jsonify(error="Username must be 3–24 characters and password at least 10 characters."), 400
    try:
        conn, pg = db_connect()
        try:
            sql = "INSERT INTO users (username, password_hash) VALUES (%s, %s) RETURNING id" if pg else "INSERT INTO users (username, password_hash) VALUES (?, ?)"
            cursor = conn.execute(sql, (username, generate_password_hash(password)))
            user_id = cursor.fetchone()[0] if pg else cursor.lastrowid
        finally:
            conn.close()
    except Exception as exc:
        logger.info("Registration failed: %s", exc)
        return jsonify(error="That username is already taken."), 409

    session.clear()
    session["user_id"] = user_id
    session["username"] = username
    return jsonify(username=username), 201


@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    try:
        conn, pg = db_connect()
        try:
            sql = "SELECT id, username, password_hash FROM users WHERE username = %s" if pg else "SELECT id, username, password_hash FROM users WHERE username = ?"
            row = conn.execute(sql, (username,)).fetchone()
        finally:
            conn.close()
    except Exception:
        return jsonify(error="Database is temporarily unavailable."), 503

    if not row:
        return jsonify(error="Incorrect username or password."), 401
    stored_hash = row[2] if pg else row["password_hash"]
    if not check_password_hash(stored_hash, password):
        return jsonify(error="Incorrect username or password."), 401

    session.clear()
    session["user_id"] = row[0] if pg else row["id"]
    session["username"] = row[1] if pg else row["username"]
    return jsonify(username=session["username"])


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
def profile():
    if not current_user():
        return jsonify(user=None, games=0, wins=0, losses=0, draws=0, win_rate=0)
    try:
        conn, pg = db_connect()
        marker = "%s" if pg else "?"
        try:
            rows = conn.execute(f"SELECT result FROM completed_games WHERE user_id={marker}", (current_user(),)).fetchall()
        finally:
            conn.close()
        results = [r[0] if pg else r["result"] for r in rows]
        wins = results.count("win")
        losses = results.count("loss")
        draws = results.count("draw")
        total = len(results)
        return jsonify(
            user=current_username(),
            games=total,
            wins=wins,
            losses=losses,
            draws=draws,
            win_rate=round(wins * 100 / total) if total else 0
        )
    except Exception:
        logger.exception("Profile fetch failed")
        return jsonify(error="Could not load profile statistics."), 503


@app.get("/api/history")
def game_history():
    if not current_user():
        return jsonify(error="Sign in to view your game history."), 401
    try:
        conn, pg = db_connect()
        marker = "%s" if pg else "?"
        try:
            rows = conn.execute(
                f"SELECT game_id, result, opponent, created_at, pgn, mode, time_control, termination, moves_count "
                f"FROM completed_games WHERE user_id={marker} ORDER BY id DESC LIMIT 50",
                (current_user(),)
            ).fetchall()
        finally:
            conn.close()

        items = []
        for r in rows:
            if pg:
                items.append({
                    "game_id": r[0],
                    "result": r[1],
                    "opponent": r[2],
                    "played_at": r[3].isoformat() if hasattr(r[3], "isoformat") else str(r[3]),
                    "pgn": r[4],
                    "mode": r[5] or "bot",
                    "time_control": r[6] or "10 min",
                    "termination": r[7] or "Normal",
                    "moves_count": r[8] or 0
                })
            else:
                items.append({
                    "game_id": r["game_id"],
                    "result": r["result"],
                    "opponent": r["opponent"],
                    "played_at": r["created_at"],
                    "pgn": r["pgn"],
                    "mode": r["mode"] or "bot",
                    "time_control": r["time_control"] or "10 min",
                    "termination": r["termination"] or "Normal",
                    "moves_count": r["moves_count"] or 0
                })
        return jsonify(games=items)
    except Exception:
        logger.exception("Game history fetch failed")
        return jsonify(error="Could not load game history."), 503


@app.post("/api/games/<game_id>/finish")
def finish_game(game_id):
    if not current_user():
        return jsonify(saved=False, reason="guest")
    data = request.get_json(silent=True) or {}
    board = games.get(game_id)
    if board is None:
        return jsonify(error="Game not found."), 404

    reason = data.get("reason", "finished")
    result = result_for_white(board.result(claim_draw=True)) if board.is_game_over(claim_draw=True) else None
    if reason in ("resign", "timeout"):
        proposed = data.get("result")
        if proposed not in ("win", "loss", "draw"):
            return jsonify(error="Invalid result."), 400
        result = proposed

    if result is None:
        return jsonify(error="Game is still in progress."), 409

    result_code = board.result(claim_draw=True) if board.is_game_over(claim_draw=True) else {"win": "1-0", "loss": "0-1", "draw": "1/2-1/2"}[result]
    term = "Time forfeit" if reason == "timeout" else ("Resignation" if reason == "resign" else reason)
    pgn = board_pgn(board, result_code, term, current_username() or "Player", str(data.get("opponent", "Computer")))

    save_completed_game(
        game_id=game_id,
        user_id=current_user(),
        result=result,
        opponent=str(data.get("opponent", "Computer")),
        pgn=pgn,
        mode="bot",
        time_control=str(data.get("time_control", "10 min")),
        termination=term,
        moves_count=len(board.move_stack)
    )
    return jsonify(saved=True)


@app.get("/api/leaderboard")
def leaderboard():
    try:
        conn, pg = db_connect()
        try:
            sql = (
                "SELECT u.username, "
                "COUNT(g.id) as games, "
                "SUM(CASE WHEN g.result='win' THEN 1 ELSE 0 END) as wins, "
                "SUM(CASE WHEN g.result='loss' THEN 1 ELSE 0 END) as losses, "
                "SUM(CASE WHEN g.result='draw' THEN 1 ELSE 0 END) as draws "
                "FROM users u "
                "LEFT JOIN completed_games g ON g.user_id = u.id "
                "GROUP BY u.id, u.username "
                "ORDER BY wins DESC, games DESC "
                "LIMIT 25"
            )
            rows = conn.execute(sql).fetchall()
        finally:
            conn.close()

        players = []
        for r in rows:
            u = r[0] if pg else r["username"]
            g = int(r[1] if pg else r["games"])
            w = int(r[2] if pg else r["wins"] or 0)
            l = int(r[3] if pg else r["losses"] or 0)
            d = int(r[4] if pg else r["draws"] or 0)
            wr = round(w * 100 / g) if g > 0 else 0
            players.append({
                "username": u,
                "games": g,
                "wins": w,
                "losses": l,
                "draws": d,
                "win_rate": wr
            })
        return jsonify(players=players)
    except Exception:
        logger.exception("Leaderboard fetch failed")
        return jsonify(error="Leaderboard is temporarily unavailable."), 503


# ── Full Authoritative WebSocket Multiplayer ────────────────────────────────

def room_payload(room: dict):
    bp = board_payload(room["board"])
    connected_players = {
        side: (room["players"][side]["username"] if room["players"].get(side) else None)
        for side in ("white", "black")
    }
    return {
        **bp,
        "room": room["code"],
        "players": len([p for p in room["players"].values() if p is not None]),
        "connected_players": connected_players,
        "clocks": room["clocks"],
        "clock_enabled": room["clock_enabled"],
        "time_control": room["time_control"],
        "draw_offered_by": room.get("draw_offered_by"),
        "finished": room["finished"]
    }


def save_room_results(room: dict, result: str, reason: str):
    if room.get("saved"):
        return
    room["saved"] = True
    white_name = room["players"].get("white", {}).get("username") or "White"
    black_name = room["players"].get("black", {}).get("username") or "Black"
    pgn = board_pgn(room["board"], result, reason, white_name, black_name)

    for side in ("white", "black"):
        player = room["players"].get(side)
        if not player or not player.get("user_id"):
            continue
        outcome = result_for_white(result)
        if side == "black":
            outcome = {"win": "loss", "loss": "win", "draw": "draw"}[outcome]
        opp = (black_name if side == "white" else white_name)
        save_completed_game(
            game_id=f"online_{room['code']}",
            user_id=player["user_id"],
            result=outcome,
            opponent=opp,
            pgn=pgn,
            mode="online",
            time_control=room["time_control"],
            termination=reason,
            moves_count=len(room["board"].move_stack)
        )


def expire_room_clock(room: dict):
    if not room["clock_enabled"] or room["finished"]:
        return None
    side = "white" if room["board"].turn == chess.WHITE else "black"
    idx = 0 if side == "white" else 1
    elapsed = max(0, time.monotonic() - room["turn_started"])
    room["clocks"][idx] = max(0, room["clocks"][idx] - elapsed)
    room["turn_started"] = time.monotonic()

    if room["clocks"][idx] > 0:
        return None

    winner = "black" if side == "white" else "white"
    result = "0-1" if winner == "black" else "1-0"
    if room["board"].has_insufficient_material(chess.WHITE if winner == "white" else chess.BLACK):
        result = "1/2-1/2"
        winner = None
    room["finished"] = True
    save_room_results(room, result, "Time forfeit")
    return {"winner": winner, "result": result, "reason": "timeout", "clocks": room["clocks"]}


if socketio:
    @socketio.on("room_create")
    def room_create(data):
        data = data if isinstance(data, dict) else {}
        try:
            seconds = max(0, min(3600, int(data.get("clock_seconds", 600))))
        except (TypeError, ValueError):
            seconds = 600

        tc_label = f"{round(seconds / 60)} min" if seconds > 0 else "No clock"
        code = secrets.token_hex(3).upper()  # 6-character clean hex code
        uid = session.get("user_id")
        uname = session.get("username") or f"Guest_{request.sid[:4]}"
        token = secrets.token_urlsafe(16)

        with lock:
            room = {
                "code": code,
                "created_at": time.monotonic(),
                "time_control": tc_label,
                "players": {
                    "white": {"sid": request.sid, "user_id": uid, "username": uname, "token": token, "connected": True},
                    "black": None
                },
                "tokens": {token: "white"},
                "board": chess.Board(),
                "clock_enabled": seconds > 0,
                "clocks": [float(seconds), float(seconds)],
                "turn_started": time.monotonic(),
                "draw_offered_by": None,
                "finished": False,
                "saved": False
            }
            rooms[code] = room
            sid_to_room[request.sid] = code

        join_room(code)
        emit("room_ready", {"color": "white", "token": token, **room_payload(room)})


    @socketio.on("room_join")
    def room_join(data):
        data = data if isinstance(data, dict) else {}
        code = str(data.get("room", "")).strip().upper()
        reconnect_token = data.get("token")

        with lock:
            room = rooms.get(code)
            if not room:
                emit("room_error", {"error": "Room not found."})
                return

            # Reconnection check
            if reconnect_token and reconnect_token in room["tokens"]:
                side = room["tokens"][reconnect_token]
                room["players"][side]["sid"] = request.sid
                room["players"][side]["connected"] = True
                sid_to_room[request.sid] = code
                join_room(code)
                emit("room_ready", {"color": side, "token": reconnect_token, **room_payload(room)})
                emit("room_player", {"color": side, "connected": True, "username": room["players"][side]["username"]}, to=code)
                emit("room_state", room_payload(room), to=code)
                return

            if room["finished"]:
                emit("room_error", {"error": "This match has already ended."})
                return

            if room["players"]["black"] is not None:
                emit("room_error", {"error": "Room is full (2 players already present)."})
                return

            # Assign Black to joining player
            uid = session.get("user_id")
            uname = session.get("username") or f"Guest_{request.sid[:4]}"
            token = secrets.token_urlsafe(16)
            room["players"]["black"] = {
                "sid": request.sid,
                "user_id": uid,
                "username": uname,
                "token": token,
                "connected": True
            }
            room["tokens"][token] = "black"
            room["turn_started"] = time.monotonic()  # Start turn clock now that both players are present
            sid_to_room[request.sid] = code

        join_room(code)
        emit("room_ready", {"color": "black", "token": token, **room_payload(room)})
        emit("room_player", {"color": "black", "connected": True, "username": uname}, to=code)
        emit("room_state", room_payload(room), to=code)


    @socketio.on("room_move")
    def room_move(data):
        data = data if isinstance(data, dict) else {}
        code = str(data.get("room", "")).strip().upper()
        with lock:
            room = rooms.get(code)
            if not room:
                emit("room_error", {"error": "Room not found."})
                return

            player_color = None
            for side in ("white", "black"):
                if room["players"].get(side) and room["players"][side]["sid"] == request.sid:
                    player_color = side
                    break

            if not player_color:
                emit("room_error", {"error": "You are not an active player in this room."})
                return

            if room["finished"]:
                emit("room_error", {"error": "This game has finished."})
                return

            if room["players"]["black"] is None:
                emit("room_error", {"error": "Waiting for opponent to join."})
                return

            board = room["board"]
            active_color = "white" if board.turn == chess.WHITE else "black"
            if player_color != active_color:
                emit("room_error", {"error": "It is not your turn to move."})
                return

            # Check for clock expiration
            timeout = expire_room_clock(room)
            if timeout:
                emit("room_over", timeout, to=code)
                return

            try:
                move = chess.Move.from_uci(data.get("move", ""))
            except (ValueError, TypeError):
                emit("room_error", {"error": "Invalid move format."})
                return

            if move not in board.legal_moves:
                emit("room_error", {"error": "Illegal chess move."})
                return

            board.push(move)
            room["turn_started"] = time.monotonic()
            room["draw_offered_by"] = None  # Reset draw offer on move

            if board.is_game_over(claim_draw=True):
                room["finished"] = True
                result = board.result(claim_draw=True)
                term = board.outcome(claim_draw=True).termination.name.replace("_", " ").title()
                save_room_results(room, result, term)
                winner = {"1-0": "white", "0-1": "black", "1/2-1/2": None}.get(result)
                emit("room_over", {"winner": winner, "result": result, "reason": term, "clocks": room["clocks"]}, to=code)

        emit("room_state", room_payload(room), to=code)


    @socketio.on("room_draw_offer")
    def room_draw_offer(data):
        data = data if isinstance(data, dict) else {}
        code = str(data.get("room", "")).strip().upper()
        with lock:
            room = rooms.get(code)
            if not room or room["finished"]:
                return
            player_color = None
            for side in ("white", "black"):
                if room["players"].get(side) and room["players"][side]["sid"] == request.sid:
                    player_color = side
                    break
            if not player_color:
                return

            if room["draw_offered_by"] and room["draw_offered_by"] != player_color:
                # Other player accepted draw
                room["finished"] = True
                save_room_results(room, "1/2-1/2", "Mutual Agreement")
                emit("room_over", {"winner": None, "result": "1/2-1/2", "reason": "Mutual agreement", "clocks": room["clocks"]}, to=code)
            else:
                room["draw_offered_by"] = player_color
                emit("room_notice", {"message": f"{player_color.title()} offered a draw."}, to=code)


    @socketio.on("room_resign")
    def room_resign(data):
        data = data if isinstance(data, dict) else {}
        code = str(data.get("room", "")).strip().upper()
        with lock:
            room = rooms.get(code)
            if not room or room["finished"]:
                return
            player_color = None
            for side in ("white", "black"):
                if room["players"].get(side) and room["players"][side]["sid"] == request.sid:
                    player_color = side
                    break
            if not player_color:
                return

            winner = "black" if player_color == "white" else "white"
            result = "0-1" if winner == "black" else "1-0"
            room["finished"] = True
            save_room_results(room, result, f"Resignation by {player_color}")
            emit("room_over", {"winner": winner, "result": result, "reason": "resignation", "clocks": room["clocks"]}, to=code)


    @socketio.on("room_clock_check")
    def room_clock_check(data):
        data = data if isinstance(data, dict) else {}
        code = str(data.get("room", "")).strip().upper()
        with lock:
            room = rooms.get(code)
            if not room or room["finished"]:
                return
            timeout = expire_room_clock(room)
            if timeout:
                emit("room_over", timeout, to=code)
            else:
                emit("room_clock", {"clocks": room["clocks"], "turn": "white" if room["board"].turn == chess.WHITE else "black"}, to=code)


    @socketio.on("disconnect")
    def on_disconnect():
        with lock:
            code = sid_to_room.pop(request.sid, None)
            if not code or code not in rooms:
                return
            room = rooms[code]
            for side in ("white", "black"):
                if room["players"].get(side) and room["players"][side]["sid"] == request.sid:
                    room["players"][side]["connected"] = False
                    emit("room_player", {"color": side, "connected": False, "username": room["players"][side]["username"]}, to=code)
                    break


# ── Server Runner ────────────────────────────────────────────────────────────

def run():
    try:
        init_db()
    except Exception as exc:
        logger.error("Database initialization failed: %s", exc)
    port = int(os.getenv("PORT", "5000"))
    if socketio:
        socketio.run(app, host="0.0.0.0", port=port, allow_unsafe_werkzeug=True)
    else:
        app.run(host="0.0.0.0", port=port)


if __name__ == "__main__":
    run()
else:
    try:
        init_db()
    except Exception as exc:
        logger.warning("Database init deferred: %s", exc)
