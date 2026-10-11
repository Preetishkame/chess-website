'use strict';
window.ChessArenaBot = {
  async move(gameId, difficulty) {
    const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/bot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ difficulty })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'The bot could not move.');
    return payload;
  }
};
