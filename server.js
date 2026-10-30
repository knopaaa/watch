const express = require('express');
const http = require('http');
const path = require('path');
const { randomUUID } = require('crypto');
const { Server } = require('socket.io');
const db = require('./db');
const videoSource = require('./public/video-source');

function createWatchServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 1e6 });
  const rooms = new Map();
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URLS && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URLS.split(',').map((url) => url.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  // --- ПРОКСИ ДЛЯ YOUTUBE (Cobalt) ---
  app.get('/api/streams/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    const cobaltInstances = [
      'https://api.cobalt.tools/',
      'https://cobalt-api.kwiatekmiki.com/',
      'https://cobalt-api.meowing.de/'
    ];

    let lastError = '';

    for (const api of cobaltInstances) {
      try {
        const response = await fetch(api, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({ 
            url: url, 
            videoQuality: '720',
            downloadMode: 'auto',
            filenamePattern: 'basic'
          })
        });

        if (!response.ok) {
          lastError += `[${api}] Status: ${response.status}; `;
          continue;
        }

        const data = await response.json();
        if (data.status === 'error') {
          lastError += `[${api}] Error: ${data.text || data.error?.code}; `;
          continue;
        }

        if (data.url) {
          return res.json({ video: data.url, type: 'mp4' });
        }
      } catch (e) {
        lastError += `[${api}] Exception: ${e.message}; `;
      }
    }
    
    console.warn('Cobalt failed. Errors:', lastError);
    res.status(404).json({ error: 'Не удалось найти видео', details: lastError });
  });
  // -----------------------------------
  
  app.use((req, res, next) => {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // --- ПРОКСИ ДЛЯ YOUTUBE (Cobalt) ---
  app.get('/api/streams/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    // Список публичных инстансов Cobalt
    const cobaltInstances = [
      'https://api.cobalt.tools/',
      'https://cobalt-api.kwiatekmiki.com/',
      'https://cobalt-api.meowing.de/',
      'https://api.cobalt.best/'
    ];

    let lastError = '';

    for (const api of cobaltInstances) {
      try {
        const response = await fetch(api, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({ 
            url: url, 
            videoQuality: '720',
            downloadMode: 'auto',
            filenamePattern: 'basic'
          })
        });

        if (!response.ok) {
          lastError += `[${api}] Status: ${response.status}; `;
          continue;
        }

        const data = await response.json();
        if (data.status === 'error') {
          lastError += `[${api}] Error: ${data.text || data.error?.code}; `;
          continue;
        }

        if (data.url) {
          return res.json({ video: data.url, type: 'mp4' });
        }
      } catch (e) {
        lastError += `[${api}] Exception: ${e.message}; `;
      }
    }
    
    console.warn('Cobalt failed. Errors:', lastError);
    res.status(404).json({ error: 'Не удалось найти видео', details: lastError });
  });
  // -----------------------------------

  app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
  app.get('/r/:roomId', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  function getRoom(id) {
    if (!rooms.has(id)) {
      rooms.set(id, {
        video: db.loadRoom(id), videoKey: randomUUID(), revision: 0,
        time: 0, playing: false, updatedAt: Date.now(),
        users: new Map(), hostId: null, screen: null
      });
    }
    return rooms.get(id);
  }
  function state(room) {
    return {
      video: room.video, videoKey: room.videoKey, revision: room.revision,
      time: room.time + (room.playing ? (Date.now() - room.updatedAt) / 1000 : 0),
      playing: room.playing, hostId: room.hostId
    };
  }
  function updateUsers(id, room) {
    io.to(id).emit('users', { users: Array.from(room.users.values()), hostId: room.hostId });
  }
  function stopScreen(id, room) {
    if (!room.screen) return;
    io.to(id).emit('rtc-stop', room.screen);
    room.screen = null;
  }
  function leaveRoom(socket) {
    const id = socket.data.roomId;
    const room = rooms.get(id);
    if (!room) return;
    if (room.screen?.presenterId === socket.id) stopScreen(id, room);
    room.users.delete(socket.id);
    socket.leave(id);
    io.to(id).emit('rtc-peer-left', { id: socket.id });
    if (room.hostId === socket.id) {
      room.hostId = room.users.keys().next().value || null;
      room.revision++;
      io.to(id).emit('sync', state(room));
    }
    updateUsers(id, room);
    io.to(id).emit('system', { text: `${socket.data.name} отключился` });
    if (!room.users.size) rooms.delete(id);
    socket.data.roomId = null;
  }

  io.on('connection', (socket) => {
    const joinedRoom = () => {
      const room = rooms.get(socket.data.roomId);
      return room?.users.has(socket.id) ? room : null;
    };
    const error = (text) => socket.emit('app-error', { text });

    socket.on('join', (data) => {
      if (!data || typeof data.roomId !== 'string' || typeof data.name !== 'string') return;
      const roomId = data.roomId.trim().slice(0, 32);
      const name = data.name.trim().slice(0, 24);
      if (!roomId || !name) return error('Нужны имя и код комнаты.');
      if (socket.data.roomId && socket.data.roomId !== roomId) leaveRoom(socket);
      const room = getRoom(roomId);
      const alreadyJoined = room.users.has(socket.id);
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.name = name;
      socket.data.color ||= '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
      room.users.set(socket.id, { id: socket.id, name, color: socket.data.color });
      room.hostId ||= socket.id;
      socket.emit('init', {
        ...state(room), history: db.getMessages(roomId, 100),
        screen: room.screen, iceServers
      });
      updateUsers(roomId, room);
      if (!alreadyJoined) {
        io.to(roomId).emit('system', { text: `${name} подключился` });
        if (room.screen) io.to(room.screen.presenterId).emit('rtc-viewer', {
          id: socket.id, sessionId: room.screen.sessionId
        });
      }
    });

    socket.on('take-control', () => {
      const room = joinedRoom();
      if (!room || room.hostId === socket.id) return;
      room.hostId = socket.id;
      room.revision++;
      io.to(socket.data.roomId).emit('sync', state(room));
      updateUsers(socket.data.roomId, room);
    });
    socket.on('sync', (data) => {
      const room = joinedRoom();
      if (!room || room.hostId !== socket.id || room.screen || !data ||
          data.videoKey !== room.videoKey || !room.video ||
          !Number.isFinite(data.time) || data.time < 0 || data.time > 30 * 86400 ||
          typeof data.playing !== 'boolean') return;
      room.time = data.time;
      room.playing = data.playing;
      room.updatedAt = Date.now();
      room.revision++;
      io.to(socket.data.roomId).emit('sync', state(room));
    });
    socket.on('setVideo', (input) => {
      const room = joinedRoom();
      if (!room) return;
      const source = typeof input === 'string' ? input
        : input?.type === 'youtube' && /^[\w-]{11}$/.test(input.id || '')
          ? `https://www.youtube.com/watch?v=${input.id}` : input?.id;
      const video = videoSource.parse(source);
      if (!video) return error('Нужна ссылка на YouTube, VK Video или прямой файл MP4/WebM/M3U8.');
      stopScreen(socket.data.roomId, room);
      room.video = video;
      room.videoKey = randomUUID();
      room.hostId = socket.id;
      room.time = 0;
      room.playing = false;
      room.updatedAt = Date.now();
      room.revision++;
      db.saveRoom(socket.data.roomId, video);
      io.to(socket.data.roomId).emit('setVideo', state(room));
      updateUsers(socket.data.roomId, room);
      io.to(socket.data.roomId).emit('system', { text: `${socket.data.name} сменил видео` });
    });

    socket.on('chat', (text) => {
      if (!joinedRoom() || typeof text !== 'string') return;
      text = text.slice(0, 500).trim();
      if (!text) return;
      const payload = { name: socket.data.name, color: socket.data.color, text, ts: Date.now() };
      db.saveMessage(socket.data.roomId, payload.name, payload.color, text);
      io.to(socket.data.roomId).emit('chat', payload);
    });
    socket.on('reaction', (emoji) => {
      const allowed = ['❤️', '😂', '😮', '💩', '😢', '👍', '🔥', '💀', '🎉', '😍', '🤯'];
      if (!joinedRoom() || !allowed.includes(emoji)) return;
      io.to(socket.data.roomId).emit('reaction', { emoji });
    });

    socket.on('rtc-start', (unused, ack) => {
      if (typeof ack !== 'function') return;
      const room = joinedRoom();
      if (!room) return ack({ ok: false, error: 'Сначала войди в комнату.' });
      if (room.screen) return ack({ ok: false, error: 'В комнате уже идёт демонстрация экрана.' });
      room.time = state(room).time;
      room.playing = false;
      room.updatedAt = Date.now();
      room.revision++;
      room.screen = { presenterId: socket.id, sessionId: randomUUID() };
      io.to(socket.data.roomId).emit('sync', state(room));
      io.to(socket.data.roomId).emit('rtc-started', room.screen);
      ack({ ok: true, ...room.screen, viewers: Array.from(room.users.keys()).filter((id) => id !== socket.id) });
    });
    for (const event of ['rtc-offer', 'rtc-answer', 'rtc-ice']) {
      socket.on(event, (data) => {
        const room = joinedRoom();
        if (!room?.screen || !data || data.sessionId !== room.screen.sessionId ||
            !room.users.has(data.to) || data.to === socket.id) return;
        const presenter = room.screen.presenterId;
        if (event === 'rtc-offer' && socket.id !== presenter) return;
        if (event === 'rtc-answer' && (data.to !== presenter || socket.id === presenter)) return;
        if (socket.id !== presenter && data.to !== presenter) return;
        if (event === 'rtc-ice') {
          if (!data.candidate || typeof data.candidate !== 'object') return;
          io.to(data.to).emit(event, { from: socket.id, sessionId: data.sessionId, candidate: data.candidate });
        } else {
          if (data.sdp?.type !== (event === 'rtc-offer' ? 'offer' : 'answer') ||
              typeof data.sdp.sdp !== 'string' || data.sdp.sdp.length > 200000) return;
          io.to(data.to).emit(event, { from: socket.id, sessionId: data.sessionId, sdp: data.sdp });
        }
      });
    }
    socket.on('rtc-stop', (data) => {
      const room = joinedRoom();
      if (room?.screen?.presenterId === socket.id && data?.sessionId === room.screen.sessionId) {
        stopScreen(socket.data.roomId, room);
      }
    });
    socket.on('disconnect', () => leaveRoom(socket));
  });
  return { app, server, io, rooms };
}

if (require.main === module) {
  const { server } = createWatchServer();
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`✅ Сервер: http://localhost:${port}`));
}
module.exports = { createWatchServer };
