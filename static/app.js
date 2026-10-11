'use strict';

/**
 * Zero Period Chess — Complete Client Application
 */

const PIECES = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟'
};

const state = {
  id: null,
  mode: 'bot', // 'bot', 'local', 'online'
  difficulty: 'medium',
  color: 'white',
  room: null,
  roomToken: null,
  socket: null,
  fen: null,
  legalMoves: new Set(),
  selected: null,
  flipped: false,
  lastData: null,
  history: [],
  clocks: [600, 600],
  clockEnabled: true,
  clockTurn: null,
  clockLastAt: 0,
  clockTick: null,
  clockEnded: false,
  finished: false,
  finishSaved: false,
  isThinking: false,
  settings: {
    theme: 'dark',
    coordinates: true,
    sound: true
  }
};

const $ = id => document.getElementById(id);

// ── Web Audio Sound Synthesizer ──────────────────────────────
class ChessAudio {
  constructor() {
    this.ctx = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  playMove() {
    if (!state.settings.sound) return;
    this.ensureContext();
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(320, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(140, this.ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.01, this.ctx.currentTime + 0.08);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.09);
    } catch (_) {}
  }

  playCapture() {
    if (!state.settings.sound) return;
    this.ensureContext();
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(450, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(80, this.ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.35, this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.01, this.ctx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.13);
    } catch (_) {}
  }

  playCheck() {
    if (!state.settings.sound) return;
    this.ensureContext();
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(620, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(380, this.ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.4, this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.01, this.ctx.currentTime + 0.2);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.21);
    } catch (_) {}
  }
}

const chessAudio = new ChessAudio();

// ── API Helper ───────────────────────────────────────────────
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({ error: 'The server returned an unreadable response.' }));
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}

// ── Toast Notifications ──────────────────────────────────────
function toast(message, type = 'info') {
  const container = $('toastContainer');
  if (!container) return;
  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  item.textContent = message;
  container.append(item);
  window.setTimeout(() => {
    item.style.opacity = '0';
    item.style.transition = 'opacity 0.3s ease';
    window.setTimeout(() => item.remove(), 320);
  }, 3500);
}

// ── Modal Confirmation Dialog ────────────────────────────────
function showConfirm(title, message) {
  return new Promise(resolve => {
    const modal = $('confirmModal');
    const titleEl = $('confirmTitle');
    const msgEl = $('confirmMessage');
    const cancelBtn = $('confirmCancelBtn');
    const okBtn = $('confirmOkBtn');

    titleEl.textContent = title;
    msgEl.textContent = message;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');

    const cleanup = confirmed => {
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      cancelBtn.removeEventListener('click', onCancel);
      okBtn.removeEventListener('click', onOk);
      resolve(confirmed);
    };

    const onCancel = () => cleanup(false);
    const onOk = () => cleanup(true);

    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onOk);
  });
}

// ── Pawn Promotion Dialog ────────────────────────────────────
function promptPromotion(pieceColor) {
  return new Promise(resolve => {
    const modal = $('promotionModal');
    const queenSpan = $('promoQueen');
    const rookSpan = $('promoRook');
    const bishopSpan = $('promoBishop');
    const knightSpan = $('promoKnight');

    if (pieceColor === 'black') {
      queenSpan.textContent = PIECES.q;
      rookSpan.textContent = PIECES.r;
      bishopSpan.textContent = PIECES.b;
      knightSpan.textContent = PIECES.n;
    } else {
      queenSpan.textContent = PIECES.Q;
      rookSpan.textContent = PIECES.R;
      bishopSpan.textContent = PIECES.B;
      knightSpan.textContent = PIECES.N;
    }

    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');

    const buttons = modal.querySelectorAll('.promo-btn');
    const handler = e => {
      const btn = e.currentTarget;
      const choice = btn.dataset.promo || 'q';
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      buttons.forEach(b => b.removeEventListener('click', handler));
      resolve(choice);
    };

    buttons.forEach(b => b.addEventListener('click', handler));
  });
}

// ── View & Navigation ────────────────────────────────────────
function showSection(id) {
  document.querySelectorAll('.app-section').forEach(section => {
    section.classList.toggle('active', section.id === id);
  });
  const activeLink = document.querySelector(`.nav-link[data-target="${id}"]`);
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.toggle('active', link === activeLink);
  });

  const titleMap = {
    homeSection: 'Dashboard',
    gameSection: 'Play Chess',
    statsSection: 'Leaderboard',
    historySection: 'Game History',
    profileSection: 'Player Profile',
    settingsSection: 'Settings'
  };
  const titleEl = $('pageTitle');
  if (titleEl) titleEl.textContent = titleMap[id] || 'Zero Period Chess';

  $('sidebar')?.classList.remove('sidebar-open');
  $('sidebarOverlay')?.classList.remove('overlay-visible');

  if (id === 'historySection') loadHistory();
  if (id === 'statsSection') loadLeaderboard();
  if (id === 'profileSection') loadProfile();
}

function pieceLabel(piece) {
  return ({
    K: 'white king', Q: 'white queen', R: 'white rook', B: 'white bishop', N: 'white knight', P: 'white pawn',
    k: 'black king', q: 'black queen', r: 'black rook', b: 'black bishop', n: 'black knight', p: 'black pawn'
  })[piece];
}

function parseFen(fen) {
  const squares = Array(64).fill(null);
  fen.split(' ')[0].split('/').forEach((rank, y) => {
    let file = 0;
    for (const token of rank) {
      if (/^[1-8]$/.test(token)) file += Number(token);
      else squares[y * 8 + file++] = token;
    }
  });
  return squares;
}

// ── Board Rendering ──────────────────────────────────────────
function render(data) {
  state.lastData = data;
  state.fen = data.fen;
  state.legalMoves = new Set(data.legal_moves || []);
  state.history = data.moves || [];
  const squares = parseFen(data.fen);
  const board = $('chessboard');
  board.replaceChildren();

  let lastFrom = null;
  let lastTo = null;
  if (data.last_move && data.last_move.length >= 4) {
    lastFrom = data.last_move.slice(0, 2);
    lastTo = data.last_move.slice(2, 4);
  }

  let checkSquare = null;
  if (data.check) {
    const kingPiece = data.turn === 'white' ? 'K' : 'k';
    const kingIdx = squares.indexOf(kingPiece);
    if (kingIdx !== -1) {
      const kf = kingIdx % 8;
      const kr = 7 - Math.floor(kingIdx / 8);
      checkSquare = 'abcdefgh'[kf] + (kr + 1);
    }
  }

  for (let index = 0; index < 64; index++) {
    const square = state.flipped ? 63 - index : index;
    const file = square % 8;
    const rank = 7 - Math.floor(square / 8);
    const algebraic = 'abcdefgh'[file] + (rank + 1);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `square ${(Math.floor(square / 8) + file) % 2 ? 'dark-square' : 'light-square'}`;
    button.dataset.square = algebraic;
    button.setAttribute('aria-label', `${algebraic}${squares[square] ? ` ${pieceLabel(squares[square])}` : ''}`);

    if (algebraic === lastFrom || algebraic === lastTo) {
      button.classList.add('last-move-square');
    }

    if (algebraic === checkSquare) {
      button.classList.add('in-check-square');
    }

    if (squares[square]) {
      const piece = document.createElement('span');
      piece.className = `piece ${squares[square] === squares[square].toUpperCase() ? 'white-piece' : 'black-piece'}`;
      piece.textContent = PIECES[squares[square]];
      button.append(piece);
    }

    if (state.selected === algebraic) {
      button.classList.add('selected-square');
    }

    if (state.selected) {
      const potentialMove = state.selected + algebraic;
      const isLegal = state.legalMoves.has(potentialMove) ||
                      state.legalMoves.has(potentialMove + 'q') ||
                      state.legalMoves.has(potentialMove + 'r') ||
                      state.legalMoves.has(potentialMove + 'b') ||
                      state.legalMoves.has(potentialMove + 'n');
      if (isLegal) {
        if (squares[square]) button.classList.add('legal-capture');
        else button.classList.add('legal-target');
      }
    }

    if (state.settings.coordinates) {
      const isBottomRank = state.flipped ? (rank === 7) : (rank === 0);
      if (isBottomRank) {
        const fileSpan = document.createElement('span');
        fileSpan.className = 'square-coord coord-file';
        fileSpan.textContent = 'abcdefgh'[file];
        button.append(fileSpan);
      }
      const isLeftFile = state.flipped ? (file === 7) : (file === 0);
      if (isLeftFile) {
        const rankSpan = document.createElement('span');
        rankSpan.className = 'square-coord coord-rank';
        rankSpan.textContent = rank + 1;
        button.append(rankSpan);
      }
    }

    button.addEventListener('click', () => handleSquare(algebraic, squares[square]));
    board.append(button);
  }

  // Turn Indicator & Status
  const turnBadge = $('turnIndicator');
  if (turnBadge) {
    turnBadge.className = `turn-badge ${data.turn === 'white' ? 'turn-white' : 'turn-black'}`;
    if (state.isThinking) {
      turnBadge.textContent = 'Bot Thinking…';
    } else {
      turnBadge.textContent = data.game_over ? 'Game Over' : `${data.turn === 'white' ? 'White' : 'Black'} to move${data.check ? ' · Check' : ''}`;
    }
  }

  const msgEl = $('gameMessage');
  if (msgEl) {
    if (state.isThinking) {
      msgEl.textContent = 'Evaluating board…';
    } else {
      msgEl.textContent = data.game_over ? `${data.status || 'Finished'} · ${data.result}` : 'Game in progress';
    }
  }

  const moveCountEl = $('moveCount');
  if (moveCountEl) {
    moveCountEl.textContent = String(Math.ceil(state.history.length / 2));
  }

  renderCapturedPieces(data.captured);
  renderMoveHistory();
  updateClocks(data.clocks, data.turn);

  if (data.game_over && state.mode !== 'online') {
    completeGame(data);
  }
}

function renderCapturedPieces(captured) {
  const oppCapturedEl = $('opponentCaptured');
  const plyCapturedEl = $('playerCaptured');
  if (!oppCapturedEl || !plyCapturedEl) return;

  oppCapturedEl.replaceChildren();
  plyCapturedEl.replaceChildren();
  if (!captured) return;

  const isPlayerWhite = (state.mode === 'online' && state.color === 'black') ? false : true;
  const playerCaptures = isPlayerWhite ? (captured.black_lost || []) : (captured.white_lost || []);
  const opponentCaptures = isPlayerWhite ? (captured.white_lost || []) : (captured.black_lost || []);

  opponentCaptures.forEach(sym => {
    const s = document.createElement('span');
    s.textContent = PIECES[sym] || '';
    oppCapturedEl.append(s);
  });

  playerCaptures.forEach(sym => {
    const s = document.createElement('span');
    s.textContent = PIECES[sym] || '';
    plyCapturedEl.append(s);
  });
}

function renderMoveHistory() {
  const container = $('moveHistory');
  if (!container) return;
  container.replaceChildren();

  if (!state.history || state.history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty text-muted';
    empty.textContent = 'No moves yet.';
    container.append(empty);
    return;
  }

  for (let i = 0; i < state.history.length; i += 2) {
    const row = document.createElement('div');
    row.className = 'move-row';

    const num = document.createElement('span');
    num.className = 'move-num';
    num.textContent = `${Math.floor(i / 2) + 1}.`;

    const whiteMove = document.createElement('span');
    whiteMove.textContent = state.history[i] || '';

    const blackMove = document.createElement('span');
    blackMove.textContent = state.history[i + 1] || '';

    row.append(num, whiteMove, blackMove);
    container.append(row);
  }
  container.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ── Move Input & Handling ────────────────────────────────────
async function handleSquare(square, piece) {
  if (state.finished || state.clockEnded || !state.fen || state.isThinking) return;
  if (state.mode === 'online') return handleOnlineSquare(square, piece);
  if (!state.id || (state.mode === 'bot' && state.lastData?.turn !== 'white')) return;

  if (state.selected) {
    const rawMove = state.selected + square;
    let isLegal = false;
    let needsPromo = false;

    if (state.legalMoves.has(rawMove)) {
      isLegal = true;
    } else if (state.legalMoves.has(rawMove + 'q') || state.legalMoves.has(rawMove + 'r')) {
      isLegal = true;
      needsPromo = true;
    }

    if (isLegal) {
      let promo = '';
      if (needsPromo) {
        promo = await promptPromotion('white');
      }
      const finalMove = rawMove + promo;
      state.selected = null;
      sendMove(finalMove);
      return;
    }
  }

  const ownPiece = piece && (state.mode === 'bot' ? piece === piece.toUpperCase() : true);
  state.selected = ownPiece ? square : null;
  render(state.lastData);
}

async function sendMove(move) {
  try {
    const data = await api(`/api/games/${encodeURIComponent(state.id)}/move`, {
      method: 'POST',
      body: JSON.stringify({ move })
    });
    state.selected = null;
    if (data.check) chessAudio.playCheck();
    else if (data.captured && (data.captured.white_lost.length > (state.lastData?.captured?.white_lost?.length || 0) ||
                               data.captured.black_lost.length > (state.lastData?.captured?.black_lost?.length || 0))) {
      chessAudio.playCapture();
    } else {
      chessAudio.playMove();
    }
    render(data);

    if (state.mode === 'bot' && !data.game_over) {
      await botMove();
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function botMove() {
  if (state.isThinking || state.finished) return;
  state.isThinking = true;
  $('turnIndicator').textContent = 'Bot Thinking…';
  $('gameMessage').textContent = `Calculating moves (${state.difficulty})…`;

  try {
    const data = await window.ChessArenaBot.move(state.id, state.difficulty);
    state.isThinking = false;
    if (data.check) chessAudio.playCheck();
    else if (data.captured && (data.captured.white_lost.length > (state.lastData?.captured?.white_lost?.length || 0) ||
                               data.captured.black_lost.length > (state.lastData?.captured?.black_lost?.length || 0))) {
      chessAudio.playCapture();
    } else {
      chessAudio.playMove();
    }
    render(data);
  } catch (error) {
    state.isThinking = false;
    toast(error.message, 'error');
    if (state.lastData) render(state.lastData);
  }
}

// ── Time Controls & Clocks ───────────────────────────────────
function clockSeconds() {
  const val = Number($('clockSetting')?.value);
  return Number.isFinite(val) ? val : 600;
}

function updateClocks(serverClocks, turn) {
  if (Array.isArray(serverClocks)) {
    state.clocks = serverClocks.map(n => Math.max(0, Math.ceil(n)));
  }

  const whiteIndex = 0;
  const blackIndex = 1;
  const playerTimerEl = $('playerTimer');
  const oppTimerEl = $('opponentTimer');

  if (state.mode === 'online' && state.color === 'black') {
    if (playerTimerEl) playerTimerEl.textContent = formatTime(state.clocks[blackIndex]);
    if (oppTimerEl) oppTimerEl.textContent = formatTime(state.clocks[whiteIndex]);
  } else {
    if (playerTimerEl) playerTimerEl.textContent = formatTime(state.clocks[whiteIndex]);
    if (oppTimerEl) oppTimerEl.textContent = formatTime(state.clocks[blackIndex]);
  }

  if (turn === 'white') {
    if (state.mode === 'online' && state.color === 'black') {
      oppTimerEl?.classList.add('clock-active');
      playerTimerEl?.classList.remove('clock-active');
    } else {
      playerTimerEl?.classList.add('clock-active');
      oppTimerEl?.classList.remove('clock-active');
    }
  } else if (turn === 'black') {
    if (state.mode === 'online' && state.color === 'black') {
      playerTimerEl?.classList.add('clock-active');
      oppTimerEl?.classList.remove('clock-active');
    } else {
      oppTimerEl?.classList.add('clock-active');
      playerTimerEl?.classList.remove('clock-active');
    }
  } else {
    playerTimerEl?.classList.remove('clock-active');
    oppTimerEl?.classList.remove('clock-active');
  }

  if (turn && turn !== state.clockTurn) beginClock(turn);
}

function beginClock(turn) {
  state.clockTurn = turn;
  clearInterval(state.clockTick);
  if (!state.clockEnabled || state.finished) return;

  state.clockLastAt = Date.now();
  state.clockTick = window.setInterval(() => {
    const now = Date.now();
    const elapsed = (now - state.clockLastAt) / 1000;
    state.clockLastAt = now;
    const index = turn === 'white' ? 0 : 1;
    state.clocks[index] = Math.max(0, state.clocks[index] - elapsed);
    updateClocks(null, turn);

    if (state.clocks[index] <= 0) {
      clearInterval(state.clockTick);
      if (state.mode === 'online') {
        state.socket?.emit('room_clock_check', { room: state.room });
      } else {
        state.clockEnded = true;
        const result = turn === 'white' ? 'loss' : 'win';
        if ($('gameMessage')) $('gameMessage').textContent = `${turn === 'white' ? 'White' : 'Black'} lost on time`;
        completeByReason(result, 'timeout');
      }
    }
  }, 200);
}

function formatTime(seconds) {
  if (seconds <= 0) return '0:00';
  const remaining = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
}

// ── Game Lifecycle Actions ───────────────────────────────────
async function startGame(mode = 'bot') {
  if (state.id && !state.finished) {
    const proceed = await showConfirm('Start New Game', 'A game is currently active. Do you want to abandon it and start a new game?');
    if (!proceed) return;
  }

  closeRoom();
  state.mode = mode;
  state.id = null;
  state.room = null;
  state.finished = false;
  state.finishSaved = false;
  state.clockEnded = false;
  state.isThinking = false;
  state.selected = null;
  state.flipped = false;
  state.clockTurn = null;
  clearInterval(state.clockTick);

  const seconds = clockSeconds();
  state.clocks = [seconds, seconds];
  state.clockEnabled = seconds > 0;
  state.difficulty = $('botDifficulty')?.value || 'medium';

  try {
    const data = await api('/api/games', {
      method: 'POST',
      body: JSON.stringify({ mode, difficulty: state.difficulty })
    });
    state.id = data.game_id;

    $('roomCodeDisplay').hidden = true;
    $('clockSettingWrapper').style.display = 'flex';
    $('undoButton').disabled = false;
    $('drawButton').hidden = true;

    const oppName = $('opponentName');
    const plyName = $('playerName');
    const modeBadge = $('gameModeBadge');

    if (mode === 'bot') {
      if (oppName) oppName.textContent = `Computer (${state.difficulty.toUpperCase()})`;
      if (plyName) plyName.textContent = 'You (White)';
      if (modeBadge) modeBadge.textContent = `Bot: ${state.difficulty.toUpperCase()}`;
    } else {
      if (oppName) oppName.textContent = 'Player 2 (Black)';
      if (plyName) plyName.textContent = 'Player 1 (White)';
      if (modeBadge) modeBadge.textContent = 'Local 2-Player';
    }

    render(data);
    showSection('gameSection');
    beginClock(data.turn);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function undo() {
  if (!state.id || state.mode === 'online' || state.finished || state.isThinking) return;
  try {
    state.selected = null;
    const data = await api(`/api/games/${encodeURIComponent(state.id)}/undo`, {
      method: 'POST',
      body: '{}'
    });
    render(data);
    toast('Move undone.', 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function resign() {
  if (!state.id && !state.room) return;
  if (state.finished) return;

  const confirmed = await showConfirm('Resign Game', 'Are you sure you want to resign this game?');
  if (!confirmed) return;

  if (state.mode === 'online' && state.room) {
    window.ChessArenaMultiplayer.resign(state.socket, state.room);
    return;
  }

  if (state.id && !state.finished) {
    await completeByReason('loss', 'resign');
    if ($('gameMessage')) $('gameMessage').textContent = 'You resigned.';
    toast('Game resigned.', 'info');
  }
}

async function offerDraw() {
  if (state.mode === 'online' && state.room) {
    window.ChessArenaMultiplayer.offerDraw(state.socket, state.room);
    toast('Draw offer sent to opponent.', 'info');
  }
}

async function completeGame(data) {
  if (state.finishSaved) return;
  state.finished = true;
  state.finishSaved = true;
  clearInterval(state.clockTick);
  const result = ({ '1-0': 'win', '0-1': 'loss', '1/2-1/2': 'draw' })[data.result];
  if (result) await saveResult(result, 'finished');
}

async function completeByReason(result, reason) {
  if (state.finishSaved || !state.id) return;
  state.finished = true;
  state.finishSaved = true;
  clearInterval(state.clockTick);
  await saveResult(result, reason);
}

async function saveResult(result, reason) {
  try {
    const opp = $('opponentName')?.textContent || 'Opponent';
    const tc = $('clockSetting')?.selectedOptions[0]?.text || '10 min';
    const saved = await api(`/api/games/${encodeURIComponent(state.id)}/finish`, {
      method: 'POST',
      body: JSON.stringify({ result, reason, opponent: opp, time_control: tc })
    });
    if (saved.saved) {
      await loadProfile();
      await loadHistory();
      await loadLeaderboard();
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ── Online Multiplayer Integration ──────────────────────────
function closeRoom() {
  clearInterval(state.clockTick);
  if (state.socket) state.socket.disconnect();
  state.socket = null;
  state.room = null;
  state.roomToken = null;
  if ($('roomCodeDisplay')) $('roomCodeDisplay').hidden = true;
  if ($('drawButton')) $('drawButton').hidden = true;
}

function startOnline(roomCode = '') {
  closeRoom();
  state.mode = 'online';
  state.id = null;
  state.finished = false;
  state.finishSaved = false;
  state.clockEnded = false;
  state.isThinking = false;
  state.selected = null;
  state.clockTurn = null;
  state.clockEnabled = clockSeconds() > 0;
  state.clocks = [clockSeconds(), clockSeconds()];

  $('clockSettingWrapper').style.display = 'none';
  $('undoButton').disabled = true;
  $('drawButton').hidden = false;

  if ($('opponentName')) $('opponentName').textContent = 'Waiting for opponent…';
  if ($('playerName')) $('playerName').textContent = 'Connecting…';
  if ($('gameModeBadge')) $('gameModeBadge').textContent = 'Multiplayer';

  showSection('gameSection');

  try {
    state.socket = window.ChessArenaMultiplayer.connect({
      roomCode,
      clockSeconds: clockSeconds(),
      token: state.roomToken,
      onState: data => {
        if (data.room) {
          state.room = data.room;
          if (data.token) state.roomToken = data.token;
          if (data.color) state.color = data.color;
          if (data.color) state.flipped = (data.color === 'black');
          $('roomCodeText').textContent = data.room;
          $('roomCodeDisplay').hidden = false;
        }

        const mySide = state.color || 'white';
        const oppSide = (mySide === 'white') ? 'black' : 'white';
        const myName = data.connected_players?.[mySide] || 'You';
        const oppName = data.connected_players?.[oppSide] || (data.players > 1 ? 'Online Opponent' : 'Waiting for opponent…');

        if ($('playerName')) $('playerName').textContent = `${myName} (${mySide.toUpperCase()})`;
        if ($('opponentName')) $('opponentName').textContent = `${oppName} (${oppSide.toUpperCase()})`;

        state.selected = null;
        render(data);
      },
      onNotice: (message, error) => toast(message, error ? 'error' : 'info'),
      onOver: data => {
        state.finished = true;
        clearInterval(state.clockTick);
        const ownWin = data.winner === state.color;
        const msg = data.winner ? (ownWin ? '🏆 You won!' : 'Loss.') : `Draw · ${data.result || ''}`;
        $('gameMessage').textContent = `${msg} (${data.reason || 'Normal'})`;
        $('turnIndicator').textContent = 'Game Over';
        toast(`Game over: ${msg}`, 'info');
        loadProfile();
        loadHistory();
        loadLeaderboard();
      },
      onClock: data => {
        state.clocks = data.clocks;
        updateClocks(data.clocks, data.turn);
      }
    });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function handleOnlineSquare(square, piece) {
  if (!state.room || state.finished) return;
  const own = piece && ((state.color === 'white') === (piece === piece.toUpperCase()));

  if (state.selected) {
    const rawMove = state.selected + square;
    let isLegal = false;
    let needsPromo = false;

    if (state.legalMoves.has(rawMove)) {
      isLegal = true;
    } else if (state.legalMoves.has(rawMove + 'q') || state.legalMoves.has(rawMove + 'r')) {
      isLegal = true;
      needsPromo = true;
    }

    if (isLegal) {
      let promo = '';
      if (needsPromo) {
        promo = await promptPromotion(state.color);
      }
      const finalMove = rawMove + promo;
      state.selected = null;
      window.ChessArenaMultiplayer.move(state.socket, state.room, finalMove);
      return;
    }
  }

  state.selected = own ? square : null;
  render(state.lastData);
}

// ── Profile, Stats & Auth ────────────────────────────────────
async function loadProfile() {
  try {
    const profile = await api('/api/me');
    if ($('gamesPlayed')) $('gamesPlayed').textContent = profile.games;
    if ($('gamesWon')) $('gamesWon').textContent = profile.wins;
    if ($('gamesLost')) $('gamesLost').textContent = profile.losses;
    if ($('gamesDrawn')) $('gamesDrawn').textContent = profile.draws;
    if ($('winRate')) $('winRate').textContent = `${profile.win_rate}%`;

    if ($('profileName')) $('profileName').textContent = profile.user || 'Guest';
    if ($('profileUsernameHeader')) $('profileUsernameHeader').textContent = profile.user || 'Guest Player';
    if ($('profileAccountStatus')) $('profileAccountStatus').textContent = profile.user ? 'Registered Member' : 'Guest Account';

    if ($('profGames')) $('profGames').textContent = profile.games;
    if ($('profWins')) $('profWins').textContent = profile.wins;
    if ($('profLosses')) $('profLosses').textContent = profile.losses;
    if ($('profDraws')) $('profDraws').textContent = profile.draws;
    if ($('profWinRate')) $('profWinRate').textContent = `${profile.win_rate}%`;

    if ($('logoutButton')) $('logoutButton').hidden = !profile.user;
    if ($('loginButton')) $('loginButton').hidden = !!profile.user;
    if ($('registerButton')) $('registerButton').hidden = !!profile.user;
    if ($('accountUsername')) $('accountUsername').disabled = !!profile.user;
    if ($('accountPassword')) $('accountPassword').disabled = !!profile.user;

    const statusText = $('accountStatusText');
    if (statusText) {
      statusText.textContent = profile.user
        ? `Logged in as ${profile.user}. Your match records and leaderboard standings are actively syncing.`
        : 'Sign in or register to record your games, track wins, and join the leaderboard.';
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function authenticate(path) {
  try {
    const u = $('accountUsername')?.value.trim();
    const p = $('accountPassword')?.value;
    if (!u || !p) {
      toast('Please enter both username and password.', 'error');
      return;
    }
    await api(path, { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
    if ($('accountPassword')) $('accountPassword').value = '';
    toast(path.endsWith('login') ? 'Welcome back!' : 'Account registered successfully.', 'success');
    await loadProfile();
    await loadHistory();
    await loadLeaderboard();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function logout() {
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
    if ($('accountUsername')) $('accountUsername').value = '';
    toast('Successfully signed out.', 'info');
    await loadProfile();
    await loadHistory();
    await loadLeaderboard();
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ── Leaderboard & History ────────────────────────────────────
async function loadLeaderboard() {
  const target = $('leaderboardContent');
  if (!target) return;
  try {
    const data = await api('/api/leaderboard');
    target.replaceChildren();
    if (!data.players || !data.players.length) {
      target.textContent = 'No recorded games yet. Play games while logged in to appear on the leaderboard.';
      return;
    }

    const table = document.createElement('table');
    table.className = 'leaderboard-table w-100';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Rank</th>
          <th>Player</th>
          <th>Wins</th>
          <th>Losses</th>
          <th>Draws</th>
          <th>Win Rate</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');

    data.players.forEach((p, idx) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><strong>#${idx + 1}</strong></td>
        <td><strong>${p.username}</strong></td>
        <td><span class="text-success">${p.wins}</span></td>
        <td><span class="text-danger">${p.losses}</span></td>
        <td><span>${p.draws}</span></td>
        <td><strong>${p.win_rate}%</strong> (${p.games} g)</td>
      `;
      tbody.append(row);
    });
    target.append(table);
  } catch (error) {
    target.textContent = error.message;
  }
}

async function loadHistory() {
  const target = $('historyContent');
  if (!target) return;
  try {
    const data = await api('/api/history');
    target.replaceChildren();
    if (!data.games || !data.games.length) {
      target.textContent = 'No saved games yet. Complete matches while signed in to review them here.';
      return;
    }

    data.games.forEach(game => {
      const card = document.createElement('div');
      card.className = 'history-match card p-3 mb-2';

      const header = document.createElement('div');
      header.className = 'history-match-header d-flex justify-content-between align-items-center';

      const date = new Date(game.played_at);
      const formattedDate = Number.isNaN(date.valueOf()) ? game.played_at : date.toLocaleString();
      const outcomeBadge = game.result === 'win'
        ? '<span class="badge badge-success">WIN</span>'
        : (game.result === 'loss' ? '<span class="badge badge-danger">LOSS</span>' : '<span class="badge badge-draw">DRAW</span>');

      header.innerHTML = `
        <div>
          ${outcomeBadge} <strong>vs ${game.opponent}</strong>
          <span class="text-muted ml-2">(${game.mode || 'bot'} · ${game.time_control || '10 min'})</span>
        </div>
        <span class="text-muted text-sm">${formattedDate}</span>
      `;

      const pgnDetails = document.createElement('details');
      pgnDetails.className = 'mt-2';
      pgnDetails.innerHTML = `
        <summary class="cursor-pointer text-muted">View Moves & PGN (${game.moves_count || 0} moves · ${game.termination || 'Normal'})</summary>
        <pre class="pgn-block mt-2 p-2">${game.pgn || 'PGN not recorded.'}</pre>
      `;

      card.append(header, pgnDetails);
      target.append(card);
    });
  } catch (error) {
    target.textContent = error.message;
  }
}

// ── Theme & Settings ─────────────────────────────────────────
function applyTheme(theme) {
  state.settings.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const themeSelect = $('settingsThemeSelect');
  if (themeSelect) themeSelect.value = theme;
  try {
    localStorage.setItem('zero-period-chess-theme', theme);
  } catch (_) {}
}

function initSettings() {
  try {
    const saved = localStorage.getItem('zero-period-chess-theme');
    if (saved === 'dark' || saved === 'light') {
      applyTheme(saved);
    }
  } catch (_) {}

  $('themeToggle')?.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });

  $('settingsThemeSelect')?.addEventListener('change', e => {
    applyTheme(e.target.value);
  });

  $('settingCoordsToggle')?.addEventListener('change', e => {
    state.settings.coordinates = e.target.checked;
    if (state.lastData) render(state.lastData);
  });

  $('settingSoundToggle')?.addEventListener('change', e => {
    state.settings.sound = e.target.checked;
  });
}

// ── Bootstrap Initialization ─────────────────────────────────
function init() {
  document.documentElement.classList.remove('no-js');
  document.documentElement.classList.add('js-ready');

  initSettings();

  document.querySelectorAll('.nav-link[data-target]').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      showSection(link.dataset.target);
    });
  });

  $('navPlayChess')?.addEventListener('click', e => {
    e.preventDefault();
    if (!state.id) startGame('bot');
    else showSection('gameSection');
  });

  $('navPlayBot')?.addEventListener('click', e => {
    e.preventDefault();
    startGame('bot');
  });

  $('navPlayOnline')?.addEventListener('click', e => {
    e.preventDefault();
    startOnline();
  });

  $('heroPlayButton')?.addEventListener('click', () => startGame('bot'));
  $('botPlayButton')?.addEventListener('click', () => startGame('bot'));
  $('onlinePlayButton')?.addEventListener('click', () => startOnline());
  $('friendPlayButton')?.addEventListener('click', () => {
    const code = window.prompt('Enter the multiplayer room code:');
    if (code?.trim()) startOnline(code.trim().toUpperCase());
  });
  $('localPlayButton')?.addEventListener('click', () => startGame('local'));

  $('newGameButton')?.addEventListener('click', () => {
    if (state.mode === 'online') startOnline();
    else startGame(state.mode);
  });
  $('backToHomeButton')?.addEventListener('click', () => {
    closeRoom();
    showSection('homeSection');
  });
  $('undoButton')?.addEventListener('click', undo);
  $('drawButton')?.addEventListener('click', offerDraw);
  $('flipBoardButton')?.addEventListener('click', () => {
    state.flipped = !state.flipped;
    if (state.lastData) render(state.lastData);
  });
  $('resignButton')?.addEventListener('click', resign);

  $('clockSetting')?.addEventListener('change', async () => {
    if (state.id && !state.finished) {
      toast('Time control will apply on your next game.', 'info');
    }
  });

  $('menuButton')?.addEventListener('click', () => {
    $('sidebar')?.classList.add('sidebar-open');
    $('sidebarOverlay')?.classList.add('overlay-visible');
  });
  $('sidebarOverlay')?.addEventListener('click', () => {
    $('sidebar')?.classList.remove('sidebar-open');
    $('sidebarOverlay')?.classList.remove('overlay-visible');
  });

  $('topProfileBadge')?.addEventListener('click', () => showSection('profileSection'));

  $('registerButton')?.addEventListener('click', () => authenticate('/api/register'));
  $('loginButton')?.addEventListener('click', () => authenticate('/api/login'));
  $('logoutButton')?.addEventListener('click', logout);

  $('copyRoomButton')?.addEventListener('click', async () => {
    if (!state.room) return;
    try {
      await navigator.clipboard.writeText(state.room);
      toast('Room code copied to clipboard!', 'success');
    } catch (_) {
      window.prompt('Copy room code:', state.room);
    }
  });

  loadProfile();
  loadLeaderboard();
  loadHistory();
}

document.addEventListener('DOMContentLoaded', init);
