const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createWatchServer } = require('../server');

function once(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error('Timeout: ' + event)); }, 3000);
    const handler = (data) => { clearTimeout(timer); resolve(data); };
    socket.once(event, handler);
  });
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function setup(t) {
  const instance = createWatchServer();
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + instance.server.address().port;
  const clients = [];
  t.after(async () => {
    clients.forEach((client) => client.disconnect());
    await new Promise((resolve) => instance.io.close(resolve));
  });
  async function join(name, room = 'test') {
    const socket = connect(base, { forceNew: true, autoConnect: false, transports: ['websocket'] });
    clients.push(socket);
    const connected = once(socket, 'connect');
    socket.connect();
    await connected;
    const initialized = once(socket, 'init');
    socket.emit('join', { roomId: room, name });
    return { socket, state: await initialized };
  }
  return { ...instance, base, join };
}
const youtube = { type: 'youtube', id: 'dQw4w9WgXcQ', url: 'https://youtu.be/dQw4w9WgXcQ' };

test('Комнаты изолированы, первый участник ведущий, чат передаётся', async (t) => {
  const { join } = await setup(t);
  const a = await join('A');
  const b = await join('B');
  const other = await join('Other', 'different');
  assert.equal(a.state.hostId, a.socket.id);
  assert.equal(b.state.hostId, a.socket.id);
  let leaked = false;
  other.socket.on('chat', () => { leaked = true; });
  const received = once(b.socket, 'chat');
  a.socket.emit('chat', 'hello');
  assert.equal((await received).text, 'hello');
  await wait(60);
  assert.equal(leaked, false);
});
test('Смена видео валидируется; ведущий синхронизирует, время новичка учитывает прошедшие секунды', async (t) => {
  const { join, rooms } = await setup(t);
  const a = await join('A');
  const b = await join('B');
  const changed = once(b.socket, 'setVideo');
  a.socket.emit('setVideo', youtube);
  const video = await changed;
  assert.equal(video.video.id, youtube.id);
  const synced = once(b.socket, 'sync');
  a.socket.emit('sync', { videoKey: video.videoKey, time: 120, playing: true });
  await synced;
  await wait(120);
  const c = await join('C');
  assert.ok(c.state.time >= 120.1 && c.state.time < 122);
  b.socket.emit('sync', { videoKey: video.videoKey, time: 999, playing: false });
  a.socket.emit('sync', { videoKey: 'old-video', time: 999, playing: false });
  await wait(60);
  assert.equal(rooms.get('test').time, 120);
  const rejected = once(a.socket, 'app-error');
  a.socket.emit('setVideo', { type: 'vk', id: null });
  await rejected;
  assert.equal(rooms.get('test').video.id, youtube.id);
  a.socket.emit('sync', null);
  a.socket.emit('setVideo', null);
  a.socket.emit('join', null);
  await wait(30);
});
test('Управление передаётся вручную и автоматически после выхода ведущего', async (t) => {
  const { join, rooms } = await setup(t);
  const a = await join('A');
  const b = await join('B');
  const transferred = once(a.socket, 'sync');
  b.socket.emit('take-control');
  assert.equal((await transferred).hostId, b.socket.id);
  const restored = once(a.socket, 'sync');
  b.socket.disconnect();
  assert.equal((await restored).hostId, a.socket.id);
  assert.equal(rooms.get('test').users.size, 1);
});
test('Повторный вход не дублирует участника, новое соединение получает комнату и историю', async (t) => {
  const { join, rooms } = await setup(t);
  const a = await join('A');
  const b = await join('B');
  const message = once(a.socket, 'chat');
  a.socket.emit('chat', 'saved message');
  await message;
  const repeated = once(b.socket, 'init');
  b.socket.emit('join', { roomId: 'test', name: 'B' });
  await repeated;
  assert.equal(rooms.get('test').users.size, 2);
  b.socket.disconnect();
  await wait(50);
  const rejoined = await join('B');
  assert.equal(rejoined.state.history.at(-1).text, 'saved message');
  assert.equal(rooms.get('test').users.size, 2);
});
test('WebRTC: несколько зрителей, адресные SDP/ICE, поздний вход, защита текущей сессии', async (t) => {
  const { join, rooms } = await setup(t);
  const a = await join('Presenter');
  const b = await join('B');
  const c = await join('C');
  const other = await join('Other', 'other-screen');
  const session = await a.socket.timeout(3000).emitWithAck('rtc-start', {});
  assert.equal(session.ok, true);
  assert.deepEqual(new Set(session.viewers), new Set([b.socket.id, c.socket.id]));
  const busy = await b.socket.timeout(3000).emitWithAck('rtc-start', {});
  assert.equal(busy.ok, false);
  let leaked = 0;
  c.socket.on('rtc-offer', () => leaked++);
  other.socket.on('rtc-offer', () => leaked++);
  const offer = once(b.socket, 'rtc-offer');
  a.socket.emit('rtc-offer', { to: b.socket.id, sessionId: session.sessionId, sdp: { type: 'offer', sdp: 'test' } });
  assert.equal((await offer).from, a.socket.id);
  const answer = once(a.socket, 'rtc-answer');
  b.socket.emit('rtc-answer', { to: a.socket.id, sessionId: session.sessionId, sdp: { type: 'answer', sdp: 'test' } });
  assert.equal((await answer).from, b.socket.id);
  const ice = once(b.socket, 'rtc-ice');
  a.socket.emit('rtc-ice', { to: b.socket.id, sessionId: session.sessionId, candidate: { candidate: 'ice' } });
  assert.equal((await ice).candidate.candidate, 'ice');
  const viewer = once(a.socket, 'rtc-viewer');
  const d = await join('Late viewer');
  assert.equal(d.state.screen.sessionId, session.sessionId);
  assert.equal((await viewer).id, d.socket.id);
  b.socket.emit('rtc-stop', { sessionId: session.sessionId });
  a.socket.emit('rtc-stop', { sessionId: 'old-session' });
  a.socket.emit('rtc-offer', { to: other.socket.id, sessionId: session.sessionId, sdp: { type: 'offer', sdp: 'test' } });
  await wait(60);
  assert.equal(leaked, 0);
  assert.ok(rooms.get('test').screen);
  const stopped = once(b.socket, 'rtc-stop');
  a.socket.disconnect();
  assert.equal((await stopped).sessionId, session.sessionId);
  assert.equal(rooms.get('test').screen, null);
});
test('Service worker и HTML требуют перепроверки кэша, обновлённые ассеты доступны', async (t) => {
  const { base } = await setup(t);
  for (const path of ['/r/example', '/app.js?v=3.0.0', '/video-source.js?v=3.0.0', '/sw.js']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-cache|max-age=0/);
  }
});
