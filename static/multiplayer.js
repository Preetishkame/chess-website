'use strict';

window.ChessArenaMultiplayer = {
  connect({ roomCode, clockSeconds, token, onState, onNotice, onOver, onClock }) {
    if (!window.io) {
      throw new Error('Socket.IO is unavailable. Check your internet connection.');
    }
    const socket = window.io(location.origin, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });

    socket.on('connect', () => {
      if (roomCode) {
        socket.emit('room_join', { room: roomCode, token });
      } else {
        socket.emit('room_create', { clock_seconds: clockSeconds });
      }
    });

    socket.on('room_ready', onState);
    socket.on('room_state', onState);
    socket.on('room_player', event => {
      const msg = event.connected
        ? `${event.username || event.color || 'Opponent'} connected.`
        : `${event.username || event.color || 'Opponent'} disconnected. Waiting for them to reconnect…`;
      onNotice(msg, false);
    });
    socket.on('room_notice', event => onNotice(event.message, false));
    socket.on('room_error', event => onNotice(event.error, true));
    socket.on('room_over', onOver);
    socket.on('room_clock', onClock);
    socket.on('connect_error', () => onNotice('Connection to multiplayer server interrupted.', true));
    return socket;
  },

  move(socket, room, move) {
    if (socket && room) socket.emit('room_move', { room, move });
  },

  offerDraw(socket, room) {
    if (socket && room) socket.emit('room_draw_offer', { room });
  },

  resign(socket, room) {
    if (socket && room) socket.emit('room_resign', { room });
  }
};
