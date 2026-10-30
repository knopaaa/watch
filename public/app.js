// Watch Together 3.0 — один источник времени, восстановление комнаты, адресный WebRTC.
const socket = io({ autoConnect: false });
const $ = (id) => document.getElementById(id);
const loginEl = $('login');
const appEl = $('app');
const nameInput = $('nameInput');
const roomInput = $('roomInput');
const joinBtn = $('joinBtn');
const roomLabel = $('roomLabel');
const usersList = $('usersList');
const urlInput = $('urlInput');
const loadBtn = $('loadBtn');
const playerContainer = $('playerContainer');
const emptyState = $('emptyState');
const screenVideo = $('screenVideo');
const messagesEl = $('messages');
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');
const shareScreenBtn = $('shareScreenBtn');
const stopScreenBtn = $('stopScreenBtn');
const takeControlBtn = $('takeControlBtn');
const playerActionBtn = $('playerActionBtn');
let myName = '';
let myRoom = '';
let joined = false;
let users = [];
let roomState = null;

function safeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function safeSet(key, value) { try { localStorage.setItem(key, value); } catch {} }
nameInput.value = safeGet('wt_name') || '';
const pathRoom = location.pathname.match(/^\/r\/([^/]+)/);
if (pathRoom) {
  try { roomInput.value = decodeURIComponent(pathRoom[1]); } catch {}
}
function notice(text = '', kind = 'info') {
  $('notice').textContent = text;
  $('notice').dataset.kind = kind;
  $('notice').classList.toggle('hidden', !text);
}
function isHost() { return joined && roomState?.hostId === socket.id; }
function updateControls() {
  loadBtn.disabled = sendBtn.disabled = !joined;
  takeControlBtn.disabled = !joined || isHost();
  shareScreenBtn.disabled = !joined || !!screenSession || screenStarting;
  const host = users.find((user) => user.id === roomState?.hostId);
  $('controlLabel').textContent = isHost() ? 'Ты управляешь видео'
    : host ? `Управляет: ${host.name}` : 'Ожидаем подключения';
  usersList.innerHTML = '';
  users.forEach((user) => {
    const badge = document.createElement('span');
    badge.className = 'user-badge';
    badge.style.background = user.color;
    badge.textContent = (user.id === roomState?.hostId ? '👑 ' : '') + user.name;
    usersList.appendChild(badge);
  });
}
function connectionStatus(text, state) {
  $('connectionStatus').textContent = text;
  $('connectionStatus').dataset.state = state;
  updateControls();
}
function joinRoom() {
  if (socket.connected && myRoom) socket.emit('join', { roomId: myRoom, name: myName });
}
function doJoin() {
  const name = nameInput.value.trim().slice(0, 24);
  if (!name) return alert('Введи имя');
  myName = name;
  myRoom = (roomInput.value.trim() || 'main').slice(0, 32);
  safeSet('wt_name', myName);
  joinBtn.disabled = true;
  joinBtn.textContent = 'Подключаемся…';
  if (socket.connected) joinRoom();
  else socket.connect();
}
joinBtn.addEventListener('click', doJoin);
[nameInput, roomInput].forEach((el) => el.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !joinBtn.disabled) doJoin();
}));
socket.on('connect', () => {
  joined = false;
  connectionStatus('Подключаемся к комнате…', 'waiting');
  joinRoom();
});
socket.on('disconnect', () => {
  joined = false;
  resetScreen(false);
  connectionStatus('Связь потеряна. Переподключаемся…', 'offline');
  notice('Соединение прервано. Комната восстановится автоматически.', 'warning');
});
socket.on('connect_error', () => {
  joined = false;
  connectionStatus('Сервер пока недоступен', 'offline');
  joinBtn.disabled = false;
  joinBtn.textContent = 'Повторить вход';
  if (myRoom) notice('Сервер не отвечает. Если он спал, запуск может занять около минуты.', 'warning');
});
socket.on('init', (data) => {
  joined = true;
  resetScreen(false);
  iceServers = Array.isArray(data.iceServers) ? data.iceServers : iceServers;
  messagesEl.innerHTML = '';
  if (Array.isArray(data.history)) data.history.forEach(addMsg);
  loginEl.classList.add('hidden');
  appEl.classList.remove('hidden');
  joinBtn.disabled = false;
  joinBtn.textContent = 'Войти в комнату';
  roomLabel.textContent = myRoom;
  history.replaceState(null, '', '/r/' + encodeURIComponent(myRoom));
  notice();
  acceptState(data, true);
  if (data.screen) startRemoteScreen(data.screen);
  connectionStatus('На связи', 'online');
});
socket.on('users', (data) => {
  users = data.users;
  if (roomState) roomState.hostId = data.hostId;
  updateControls();
});
socket.on('setVideo', (data) => acceptState(data, true));
socket.on('sync', (data) => acceptState(data));
socket.on('app-error', ({ text }) => notice(text, 'error'));
takeControlBtn.addEventListener('click', () => {
  if (joined) socket.emit('take-control');
});

function addMsg({ name, color, text, system }) {
  const div = document.createElement('div');
  div.className = 'msg' + (system ? ' system' : '');
  if (system) div.textContent = '— ' + text;
  else {
    const author = document.createElement('span');
    author.className = 'author';
    author.style.color = color || '#ff2d78';
    author.textContent = name + ':';
    div.appendChild(author);
    div.appendChild(document.createTextNode(text));
  }
  messagesEl.appendChild(div);
  while (messagesEl.children.length > 200) messagesEl.firstChild.remove();
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
socket.on('chat', addMsg);
socket.on('system', ({ text }) => addMsg({ text, system: true }));
function sendChat() {
  const text = chatInput.value.trim();
  if (!joined || !text) return;
  socket.emit('chat', text);
  chatInput.value = '';
}
sendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') sendChat(); });
$('leaveBtn').addEventListener('click', () => location.reload());
$('copyLinkBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    notice('Ссылка на комнату скопирована.');
  } catch { prompt('Скопируй ссылку:', location.href); }
});
document.querySelectorAll('.react-btn').forEach((button) => {
  button.addEventListener('click', () => { if (joined) socket.emit('reaction', button.dataset.emoji); });
});
socket.on('reaction', ({ emoji }) => {
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;
  el.style.left = (5 + Math.random() * 90) + '%';
  el.style.fontSize = (32 + Math.random() * 24) + 'px';
  el.style.animationDuration = (2 + Math.random() * 1.2) + 's';
  $('emojiLayer').appendChild(el);
  setTimeout(() => el.remove(), 3600);
});

// ---------- ЗАГРУЗКА API (не блокирует чат и вход, есть тайм-аут и повтор) ----------
const libraries = new Map();
function loadLibrary(key, src, available, callbackName) {
  if (available()) return Promise.resolve();
  if (libraries.has(key)) return libraries.get(key);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) { script.remove(); reject(error); }
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`Не удалось загрузить ${key}. Проверь доступ к сервису и расширения браузера.`)), 15000);
    if (callbackName) window[callbackName] = () => finish(available() ? null : new Error(`API ${key} не готов.`));
    script.src = src;
    script.async = true;
    script.onerror = () => finish(new Error(`Не удалось загрузить ${key}. Проверь доступ к сервису и расширения браузера.`));
    script.onload = () => { if (available()) finish(); };
    document.head.appendChild(script);
  });
  libraries.set(key, promise);
  promise.catch(() => { if (libraries.get(key) === promise) libraries.delete(key); });
  return promise;
}

let playerGeneration = 0;
let currentType = null;
let playerReady = false;
let ytPlayer = null;
let vkPlayer = null;
let fileVideoEl = null;
let hlsInstance = null;
let vkAd = false;
let suppressUntil = 0;
let readyTimer = null;

function desiredState() {
  if (!roomState) return { time: 0, playing: false };
  return {
    time: roomState.time + (roomState.playing ? (Date.now() - roomState.receivedAt) / 1000 : 0),
    playing: roomState.playing
  };
}
function acceptState(data, reload = false) {
  if (!data || !Number.isFinite(data.time)) return;
  const previous = roomState;
  if (!reload && previous?.videoKey === data.videoKey && data.revision < previous.revision) return;
  roomState = { ...data, receivedAt: Date.now() };
  updateControls();
  if (reload || previous?.videoKey !== data.videoKey) {
    loadVideo(data.video);
  } else if (!isHost() || previous?.hostId !== data.hostId) {
    applySync();
  }
}
function clearPlayerArea() {
  playerGeneration++;
  playerReady = false;
  clearTimeout(readyTimer);
  readyTimer = null;
  suppressUntil = Date.now() + 1500;
  if (ytPlayer?.destroy) { try { ytPlayer.destroy(); } catch {} }
  if (vkPlayer?.destroy) { try { vkPlayer.destroy(); } catch {} }
  if (hlsInstance) hlsInstance.destroy();
  if (fileVideoEl) {
    fileVideoEl.pause();
    fileVideoEl.removeAttribute('src');
    fileVideoEl.load();
  }
  ytPlayer = vkPlayer = fileVideoEl = hlsInstance = null;
  vkAd = false;
  currentType = null;
    if (fileVideoEl && fileVideoEl._audioEl) {
    fileVideoEl._audioEl.pause();
    fileVideoEl._audioEl.src = '';
  }
  playerContainer.innerHTML = '';
  playerActionBtn.classList.add('hidden');
}
function playbackBlocked() {
  playerActionBtn.classList.remove('hidden');
  notice('Браузер ждёт твоего нажатия. Нажми «Включить просмотр» — затем подключится синхронизация.', 'warning');
}
function playerFailed(text, generation) {
  if (generation !== playerGeneration) return;
  clearTimeout(readyTimer);
  notice(text, 'error');
}
function ready(generation) {
  if (generation !== playerGeneration) return;
  clearTimeout(readyTimer);
  playerReady = true;
  applySync();
}
async function loadVideo(video) {
  clearPlayerArea();
  notice();
  emptyState.classList.toggle('hidden', !!video || !!screenSession);
  if (!video) return;
  const generation = playerGeneration;
  currentType = video.type;
  readyTimer = setTimeout(() => playerFailed('Плеер не ответил. Проверь доступ к видео; для VK попробуй ссылку из «Поделиться → Экспорт».', generation), 25000);
  try {
    if (video.type === 'youtube') await createYouTube(video.id, generation);
    else if (video.type === 'vk') await createVK(video.id, generation);
    else if (video.type === 'file') await createFile(video.id, generation);
  } catch (error) { playerFailed(error.message, generation); }
}
async function createYouTube(id, generation) {
  if (generation !== playerGeneration) return;

  const wrapper = document.createElement('div');
  wrapper.style.width = '100%';
  wrapper.style.height = '100%';
  wrapper.style.display = 'flex';
  wrapper.style.flexDirection = 'column';
  wrapper.style.alignItems = 'center';
  wrapper.style.justifyContent = 'center';
  wrapper.style.color = '#8a8a9a';
  wrapper.style.gap = '10px';
  wrapper.innerHTML = '<div>Загрузка видео через Invidious... ⏳</div>';
  playerContainer.appendChild(wrapper);

  // Сервера Invidious, у которых открыт CORS для браузеров
  const invidiousInstances = [
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://yewtu.be',
    'https://invidious.f5.si',
    'https://invidious.privacyredirect.com'
  ];

  let videoLoaded = false;

  async function tryFetchStream(index) {
    if (videoLoaded || generation !== playerGeneration) return;
    if (index >= invidiousInstances.length) {
      wrapper.innerHTML = '<div style="color:#ff5c9a; text-align:center; padding: 20px;">Ошибка: Все сервера Invidious недоступны.<br><br>Включите VPN или используйте 🖥️ Экран.</div>';
      return;
    }

    const api = invidiousInstances[index];
    wrapper.querySelector('div').textContent = `Загрузка... (сервер ${index + 1} из ${invidiousInstances.length})`;
    
    try {
      const res = await fetch(`${api}/api/v1/videos/${id}`);
      if (!res.ok) throw new Error('API Error');
      
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      // Ищем лучший видеопоток
      const format = data.formatStreams?.find(f => f.container === 'mp4' && f.resolution === '720p') 
                  || data.formatStreams?.find(f => f.container === 'mp4') 
                  || data.formatStreams?.[0];

      if (!format) throw new Error('No video stream');
      if (generation !== playerGeneration) return;

      videoLoaded = true;
      wrapper.remove(); 

      const video = document.createElement('video');
      fileVideoEl = video; 
      currentType = 'file'; 
      
      video.controls = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      video.style.width = '100%';
      video.style.height = '100%';
      playerContainer.appendChild(video);

      // Invidious отдает видео и звук вместе в mp4, поэтому HLS не нужен
      video.src = format.url;

      ['play', 'pause', 'seeked', 'ended'].forEach((event) => video.addEventListener(event, () => {
        if (generation !== playerGeneration) return;
        if (!video.paused) playerActionBtn.classList.add('hidden');
        reportPlayback(!video.paused && !video.ended);
      }));

      video.addEventListener('loadedmetadata', () => ready(generation), { once: true });

    } catch (err) {
      console.warn(`Invidious server ${api} failed:`, err);
      setTimeout(() => tryFetchStream(index + 1), 500); 
    }
  }

  tryFetchStream(0);
}

async function createVK(url, generation) {
  await loadLibrary('VK Video', 'https://vk.com/js/api/videoplayer.js', () => typeof window.VK?.VideoPlayer === 'function');
  if (generation !== playerGeneration) return;
  const frame = document.createElement('iframe');
  frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture; screen-wake-lock';
  frame.title = 'VK Video';
  frame.addEventListener('load', () => {
    if (generation !== playerGeneration) return;
    if (vkPlayer) vkPlayer.destroy();
    // Официальный SDK выполняет init, проверяет источник сообщений и ставит команды в очередь.
    vkPlayer = VK.VideoPlayer(frame);
    vkPlayer.on('inited', () => ready(generation));
    ['started', 'resumed', 'paused', 'ended', 'seeked'].forEach((event) => {
      vkPlayer.on(event, () => {
        if (generation !== playerGeneration || vkAd) return;
        if (['started', 'resumed'].includes(event)) playerActionBtn.classList.add('hidden');
        reportPlayback(vkPlayer.getState() === 'playing');
      });
    });
    vkPlayer.on('adStarted', () => { vkAd = true; });
    vkPlayer.on('adCompleted', () => { vkAd = false; applySync(); });
    vkPlayer.on('autoplaySoundProhibited', playbackBlocked);
    vkPlayer.on('error', () => playerFailed('VK не может открыть видео. Проверь его доступность и разрешение на встраивание; попробуй ссылку из «Поделиться → Экспорт».', generation));
  });
  frame.src = url;
  playerContainer.appendChild(frame);
}
async function createFile(url, generation) {
  const video = document.createElement('video');
  fileVideoEl = video;
  video.controls = true;
  video.playsInline = true;
  // Обычный MP4 не требует CORS. HLS через hls.js по-прежнему требует разрешения источника.
  video.style.width = video.style.height = '100%';
  playerContainer.appendChild(video);
  video.addEventListener('loadedmetadata', () => ready(generation), { once: true });
  video.addEventListener('error', () => playerFailed('Не удалось открыть видеофайл. Нужна прямая доступная ссылка; для HLS источник должен разрешать CORS.', generation));
  ['play', 'pause', 'seeked', 'ended'].forEach((event) => video.addEventListener(event, () => {
    if (generation !== playerGeneration) return;
    if (!video.paused) playerActionBtn.classList.add('hidden');
    reportPlayback(!video.paused && !video.ended);
  }));
  if (!/\.m3u8(?:[?#]|$)/i.test(url) || video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    return;
  }
  await loadLibrary('HLS', 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js', () => !!window.Hls);
  if (generation !== playerGeneration) return;
  if (!Hls.isSupported()) throw new Error('Этот браузер не поддерживает HLS. Попробуй другой браузер или MP4.');
  const hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60 });
  hlsInstance = hls;
  let attempts = 0;
  hls.on(Hls.Events.ERROR, (event, data) => {
    if (!data.fatal || generation !== playerGeneration) return;
    if (++attempts <= 2 && data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
    else if (attempts <= 2 && data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    else {
      playerFailed('Не удалось загрузить HLS. Проверь доступность ссылки и CORS на сервере видео.', generation);
      hls.destroy();
      if (hlsInstance === hls) hlsInstance = null;
    }
  });
  hls.attachMedia(video);
  hls.loadSource(url);
}
function playbackSnapshot() {
  if (!playerReady) return null;
  try {
    if (currentType === 'youtube' && ytPlayer?.getPlayerState) {
      const state = ytPlayer.getPlayerState();
      if (state === 3 || state === -1 || state === 5) return null; // Буферизация/ожидание, не реклама.
      return { time: ytPlayer.getCurrentTime(), playing: state === 1 };
    }
    if (currentType === 'vk' && vkPlayer && !vkAd) {
      return { time: vkPlayer.getCurrentTime(), playing: vkPlayer.getState() === 'playing' };
    }
    if (currentType === 'file' && fileVideoEl?.readyState >= 1) {
      return { time: fileVideoEl.currentTime, playing: !fileVideoEl.paused && !fileVideoEl.ended };
    }
  } catch {}
  return null;
}
function reportPlayback(playing) {
  if (!isHost() || screenSession || Date.now() < suppressUntil) return;
  const snapshot = playbackSnapshot();
  if (!snapshot || !Number.isFinite(snapshot.time)) return;
  socket.emit('sync', { time: snapshot.time, playing, videoKey: roomState.videoKey });
}
function applySync() {
  if (!playerReady || screenSession || !roomState?.video || vkAd) return;
  const target = desiredState();
  const generation = playerGeneration;
  try {
    const snapshot = playbackSnapshot();
    const seek = !snapshot || Math.abs(snapshot.time - target.time) > (target.playing ? 1.5 : 0.3);
    suppressUntil = Date.now() + 1500;
    if (currentType === 'youtube' && ytPlayer) {
      if (seek) ytPlayer.seekTo(target.time, true);
      if (target.playing) ytPlayer.playVideo();
      else ytPlayer.pauseVideo();
    } else if (currentType === 'vk' && vkPlayer) {
      if (seek) vkPlayer.seek(target.time);
      if (target.playing) vkPlayer.play();
      else vkPlayer.pause();
    } else if (currentType === 'file' && fileVideoEl) {
      if (seek) fileVideoEl.currentTime = target.time;
      if (target.playing) fileVideoEl.play().catch(() => {
        if (generation === playerGeneration && roomState?.playing) playbackBlocked();
      });
      else fileVideoEl.pause();
    }
  } catch (error) { playerFailed('Не удалось применить синхронизацию: ' + error.message, generation); }
}
setInterval(() => {
  const snapshot = playbackSnapshot();
  if (snapshot) reportPlayback(snapshot.playing);
}, 3000);
playerActionBtn.addEventListener('click', () => {
  if (screenSession && screenVideo.srcObject) {
    screenVideo.play().then(() => { playerActionBtn.classList.add('hidden'); notice(); })
      .catch(() => notice('Нажми ▶ в плеере демонстрации экрана.', 'warning'));
    return;
  }
  // Явное нажатие разрешает воспроизведение со звуком и у зрителя.
  suppressUntil = isHost() ? 0 : Date.now() + 1500;
  if (currentType === 'youtube') ytPlayer?.playVideo();
  else if (currentType === 'vk') vkPlayer?.play();
  else if (fileVideoEl) fileVideoEl.play().catch(playbackBlocked);
  playerActionBtn.classList.add('hidden');
  notice();
});
loadBtn.addEventListener('click', () => {
  if (!joined) return;
  const video = WatchVideo.parse(urlInput.value);
  if (!video) return notice('Вставь ссылку на YouTube, VK Video или прямой файл MP4/WebM/M3U8. Обычная страница другого сайта не подойдёт.', 'error');
  if (location.protocol === 'https:' && video.id.startsWith('http:')) {
    return notice('На HTTPS-сайте нужна HTTPS-ссылка на видеофайл.', 'error');
  }
  socket.emit('setVideo', video);
});
urlInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') loadBtn.click(); });

// ---------- ДЕМОНСТРАЦИЯ ЭКРАНА: отдельный peer на каждого зрителя ----------
const peers = new Map();
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
let localStream = null;
let screenSession = null;
let screenStarting = false;
const waitingViewers = new Set();

function pauseLocalPlayer() {
  suppressUntil = Date.now() + 1500;
  try { ytPlayer?.pauseVideo(); vkPlayer?.pause(); fileVideoEl?.pause(); } catch {}
}
function showScreen() {
  pauseLocalPlayer();
  screenVideo.classList.remove('hidden');
  playerContainer.classList.add('hidden');
  emptyState.classList.add('hidden');
}
function resetScreen(notify = false) {
  const old = screenSession;
  screenSession = null;
  screenStarting = false;
  waitingViewers.clear();
  for (const record of peers.values()) record.pc.close();
  peers.clear();
  const stream = localStream;
  localStream = null;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  screenVideo.srcObject = null;
  screenVideo.classList.add('hidden');
  playerContainer.classList.remove('hidden');
  emptyState.classList.toggle('hidden', !!roomState?.video);
  playerActionBtn.classList.add('hidden');
  shareScreenBtn.classList.remove('hidden');
  stopScreenBtn.classList.add('hidden');
  if (notify && joined && old?.presenterId === socket.id) {
    socket.emit('rtc-stop', { sessionId: old.sessionId });
  }
  updateControls();
}
function startRemoteScreen(session) {
  if (screenSession?.sessionId === session.sessionId) return;
  resetScreen(false);
  screenSession = session;
  showScreen();
  updateControls();
}
function validPeer(record) {
  return joined && peers.get(record.id) === record && screenSession?.sessionId === record.sessionId;
}
function ensurePeer(id) {
  if (peers.has(id)) return peers.get(id);
  const pc = new RTCPeerConnection({ iceServers });
  const record = { id, pc, sessionId: screenSession.sessionId, pendingIce: [] };
  peers.set(id, record);
  if (localStream) localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && validPeer(record)) socket.emit('rtc-ice', {
      to: id, sessionId: record.sessionId, candidate: candidate.toJSON()
    });
  };
  pc.ontrack = ({ streams }) => {
    if (!validPeer(record) || !streams[0]) return;
    screenVideo.srcObject = streams[0];
    screenVideo.muted = false;
    screenVideo.controls = true;
    showScreen();
    screenVideo.play().catch(playbackBlocked);
  };
  pc.onconnectionstatechange = () => {
    if (validPeer(record) && pc.connectionState === 'failed') {
      notice('Не удалось соединить устройства для демонстрации. Попробуйте другую сеть; для некоторых сетей нужен TURN-сервер.', 'error');
    }
  };
  return record;
}
async function drainIce(record) {
  while (validPeer(record) && record.pc.remoteDescription && record.pendingIce.length) {
    await record.pc.addIceCandidate(record.pendingIce.shift());
  }
}
async function offerViewer(id) {
  if (!localStream || !screenSession || peers.has(id) || id === socket.id) return;
  const record = ensurePeer(id);
  try {
    const offer = await record.pc.createOffer();
    if (!validPeer(record)) return;
    await record.pc.setLocalDescription(offer);
    if (validPeer(record)) socket.emit('rtc-offer', { to: id, sessionId: record.sessionId, sdp: record.pc.localDescription.toJSON() });
  } catch (error) {
    if (validPeer(record)) notice('Не удалось подключить зрителя: ' + error.message, 'error');
  }
}
shareScreenBtn.addEventListener('click', async () => {
  if (!joined || screenSession || screenStarting) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return notice('Этот браузер не поддерживает передачу экрана. Открой сайт в настольном Chrome или Edge.', 'error');
  }
  screenStarting = true;
  updateControls();
  let captured = null;
  const startingId = socket.id;
  try {
    captured = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
    if (!joined || startingId !== socket.id || !screenStarting) throw new Error('Соединение изменилось. Запусти демонстрацию заново.');
    const response = await new Promise((resolve, reject) => {
      socket.timeout(10000).emit('rtc-start', {}, (error, result) => {
        if (error) reject(new Error('Сервер не подтвердил демонстрацию. Попробуй ещё раз.'));
        else if (!result?.ok) reject(new Error(result?.error || 'Демонстрация недоступна.'));
        else resolve(result);
      });
    });
    if (!joined || startingId !== socket.id || !screenStarting ||
        screenSession?.sessionId !== response.sessionId ||
        !captured.getVideoTracks().some((track) => track.readyState === 'live')) {
      throw new Error('Демонстрация завершилась до подключения. Попробуй ещё раз.');
    }
    screenSession = { presenterId: socket.id, sessionId: response.sessionId };
    localStream = captured;
    captured = null;
    localStream.getVideoTracks()[0].addEventListener('ended', () => resetScreen(true), { once: true });
    screenVideo.srcObject = localStream;
    screenVideo.muted = true; // Не возвращать собственный звук в колонки.
    screenVideo.controls = false;
    showScreen();
    screenVideo.play().catch(playbackBlocked);
    shareScreenBtn.classList.add('hidden');
    stopScreenBtn.classList.remove('hidden');
    screenStarting = false;
    notice(localStream.getAudioTracks().length ? 'Экран передаётся со звуком.'
      : 'Экран передаётся без звука. Чтобы передать звук, выбери вкладку браузера и включи общий доступ к её аудио.', 'info');
    const viewers = new Set([...response.viewers, ...waitingViewers]);
    waitingViewers.clear();
    await Promise.all(Array.from(viewers, offerViewer));
  } catch (error) {
    if (captured) captured.getTracks().forEach((track) => track.stop());
    // Не закрывать чужую демонстрацию, если сервер отказал из-за занятой комнаты.
    if (screenSession?.presenterId === socket.id) resetScreen(true);
    if (error.name !== 'NotAllowedError') notice(error.message, 'error');
  } finally {
    screenStarting = false;
    updateControls();
  }
});
stopScreenBtn.addEventListener('click', () => resetScreen(true));
socket.on('rtc-started', (session) => {
  if (session.presenterId === socket.id && screenStarting) {
    screenSession = session;
    return;
  }
  startRemoteScreen(session);
});
socket.on('rtc-viewer', ({ id, sessionId }) => {
  if (screenSession?.sessionId !== sessionId || screenSession.presenterId !== socket.id) return;
  if (screenStarting) waitingViewers.add(id);
  else offerViewer(id);
});
socket.on('rtc-offer', async ({ from, sessionId, sdp }) => {
  if (!joined || screenSession?.sessionId !== sessionId || screenSession.presenterId !== from) return;
  try {
    const record = ensurePeer(from);
    await record.pc.setRemoteDescription(sdp);
    if (!validPeer(record)) return;
    await drainIce(record);
    const answer = await record.pc.createAnswer();
    if (!validPeer(record)) return;
    await record.pc.setLocalDescription(answer);
    if (validPeer(record)) socket.emit('rtc-answer', { to: from, sessionId, sdp: record.pc.localDescription.toJSON() });
  } catch (error) { if (screenSession?.sessionId === sessionId) notice('Ошибка приёма экрана: ' + error.message, 'error'); }
});
socket.on('rtc-answer', async ({ from, sessionId, sdp }) => {
  const record = peers.get(from);
  if (!record || !validPeer(record) || record.sessionId !== sessionId) return;
  try {
    await record.pc.setRemoteDescription(sdp);
    await drainIce(record);
  } catch (error) { if (validPeer(record)) notice('Ошибка подключения зрителя: ' + error.message, 'error'); }
});
socket.on('rtc-ice', async ({ from, sessionId, candidate }) => {
  if (!joined || !screenSession || screenSession.sessionId !== sessionId) return;
  if (screenSession.presenterId !== socket.id && screenSession.presenterId !== from) return;
  try {
    const record = ensurePeer(from);
    record.pendingIce.push(candidate);
    await drainIce(record);
  } catch (error) { if (screenSession?.sessionId === sessionId) notice('Ошибка сетевого соединения экрана: ' + error.message, 'warning'); }
});
socket.on('rtc-peer-left', ({ id }) => {
  const record = peers.get(id);
  if (record) { record.pc.close(); peers.delete(id); }
});
socket.on('rtc-stop', ({ sessionId }) => {
  if (screenSession?.sessionId === sessionId) { resetScreen(false); applySync(); }
});

// Новая версия SW получает управление один раз и загружает свежие HTML/JS.
if ('serviceWorker' in navigator) {
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloading) { reloading = true; location.reload(); }
  });
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    .then((registration) => registration.update()).catch(() => {});
}
connectionStatus('Подключаемся…', 'waiting');
socket.connect();
