const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createWatchServer } = require('../server');

// Плееры детерминированы: тестируем приложение, не доступность внешнего видео.
const youtubeSDK = `
window.YT = { Player: class {
  constructor(element, options) {
    this.options = options; this.time = 0; this.state = 2; this.at = Date.now();
    element.textContent = 'YouTube test player';
    setTimeout(() => options.events.onReady({ target: this }), 0);
  }
  getCurrentTime() { return this.time + (this.state === 1 ? (Date.now() - this.at) / 1000 : 0); }
  getPlayerState() { return this.state; }
  seekTo(time) { this.time = time; this.at = Date.now(); }
  change(state) {
    this.time = this.getCurrentTime(); this.at = Date.now(); this.state = state;
    setTimeout(() => this.options.events.onStateChange({ data: state, target: this }), 0);
  }
  playVideo() { this.change(1); }
  pauseVideo() { this.change(2); }
  destroy() {}
}}; window.onYouTubeIframeAPIReady?.();`;

// Контракт официального VK SDK: init, объект сообщения, time на верхнем уровне,
// проверки source, события и публичные методы. Сам iframe ниже — тестовый медиасервис.
const vkSDK = `
window.VK = { VideoPlayer(frame) {
  const handlers = {}, state = { state: 'unstarted', time: 0 };
  const send = (data) => frame.contentWindow.postMessage(data, new URL(frame.src).origin);
  const listener = (event) => {
    if (event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') return;
    Object.assign(state, event.data);
    (handlers[event.data.event] || []).forEach((fn) => fn(state));
  };
  window.addEventListener('message', listener);
  send({ method: 'init' });
  return {
    on(event, fn) { (handlers[event] ||= []).push(fn); },
    play() { send({ method: 'play' }); }, pause() { send({ method: 'pause' }); },
    seek(time) { send({ method: 'seek', time }); },
    getCurrentTime() { return state.time; }, getState() { return state.state; },
    destroy() { window.removeEventListener('message', listener); }
  };
}};`;
const vkFrame = `<!doctype html><title>VK test player</title><script>
let time = 0, state = 'unstarted', at = Date.now();
function post(event) { parent.postMessage({ event, time, state }, '*'); }
setInterval(() => { if (state === 'playing') time += (Date.now() - at) / 1000; at = Date.now(); post('timeupdate'); }, 100);
window.addEventListener('message', ({ data }) => {
  if (!data || typeof data !== 'object' || data.params) return;
  if (data.method === 'init') post('inited');
  if (data.method === 'seek') { time = data.time; at = Date.now(); post('seeked'); }
  if (data.method === 'play') { state = 'playing'; at = Date.now(); post('started'); }
  if (data.method === 'pause') { state = 'paused'; post('paused'); }
});</script>`;

async function setup(t) {
  const instance = createWatchServer();
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + instance.server.address().port;
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.WATCH_TEST_BROWSER ? { executablePath: process.env.WATCH_TEST_BROWSER }
      : process.platform === 'win32' ? { channel: 'msedge' } : {}),
    args: ['--autoplay-policy=no-user-gesture-required']
  });
  const errors = [];
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => instance.io.close(resolve));
    assert.deepEqual(errors, [], 'В браузере не должно быть необработанных исключений');
  });
  async function join(name, room = 'browser') {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('https://www.youtube.com/iframe_api', (route) => route.fulfill({ contentType: 'text/javascript', body: youtubeSDK }));
    await context.route('https://vk.com/js/api/videoplayer.js', (route) => route.fulfill({ contentType: 'text/javascript', body: vkSDK }));
    await context.route(/https:\/\/(?:vk\.com|vkvideo\.ru)\/video_ext\.php/, (route) => route.fulfill({ contentType: 'text/html', body: vkFrame }));
    await context.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 160; canvas.height = 90;
        const ctx = canvas.getContext('2d');
        let n = 0;
        const timer = setInterval(() => {
          ctx.fillStyle = n++ % 2 ? '#ff2d78' : '#12121a';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }, 50);
        const stream = canvas.captureStream(10);
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
        return stream;
      };
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    await page.fill('#nameInput', name);
    await page.fill('#roomInput', room);
    await page.click('#joinBtn');
    await page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'На связи');
    return { page, context };
  }
  async function load(page, url) {
    await page.fill('#urlInput', url);
    await page.click('#loadBtn');
    await page.waitForFunction(() => playerReady);
  }
  return { ...instance, base, browser, join, load };
}

test('Браузеры: YouTube, передача управления, запрет автозапуска, переподключение', { timeout: 60000 }, async (t) => {
  const { join, load } = await setup(t);
  const a = await join('Alice');
  const b = await join('Bella');
  await load(a.page, 'https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ');
  await b.page.waitForFunction(() => playerReady && currentType === 'youtube');
  await a.page.waitForTimeout(1700);
  await a.page.evaluate(() => { ytPlayer.seekTo(42); ytPlayer.playVideo(); });
  await b.page.waitForFunction(() => ytPlayer?.getPlayerState() === 1 && ytPlayer.getCurrentTime() >= 42);
  await a.page.evaluate(() => ytPlayer.pauseVideo());
  await b.page.waitForFunction(() => ytPlayer?.getPlayerState() === 2);
  // Зритель не может остановить/перемотать ведущую своей периодической позицией.
  await b.page.evaluate(() => ytPlayer.seekTo(900));
  await a.page.waitForTimeout(3200);
  assert.ok(await a.page.evaluate(() => ytPlayer.getCurrentTime() < 100));
  await b.page.click('#takeControlBtn');
  await b.page.waitForFunction(() => isHost());
  await b.page.waitForTimeout(1700);
  await b.page.evaluate(() => { ytPlayer.seekTo(80); ytPlayer.playVideo(); });
  await a.page.waitForFunction(() => ytPlayer.getCurrentTime() >= 80 && ytPlayer.getPlayerState() === 1);
  await a.page.evaluate(() => ytPlayer.options.events.onAutoplayBlocked());
  assert.equal(await a.page.isVisible('#playerActionBtn'), true);
  await a.page.click('#playerActionBtn');
  const oldId = await a.page.evaluate(() => socket.id);
  await a.context.setOffline(true);
  await a.page.waitForFunction(() => !joined);
  assert.equal(await a.page.isDisabled('#loadBtn'), true);
  await a.context.setOffline(false);
  await a.page.waitForFunction((id) => joined && socket.id !== id && playerReady, oldId);
  await a.page.fill('#chatInput', 'after reconnect');
  await a.page.click('#sendBtn');
  await b.page.waitForFunction(() => document.getElementById('messages').textContent.includes('after reconnect'));
  assert.equal(await a.page.locator('.user-badge').count(), 2);
});

test('Браузеры: VK init, перемотка/пауза и состояние позднего участника', { timeout: 45000 }, async (t) => {
  const { join, load } = await setup(t);
  const a = await join('Alice');
  const b = await join('Bella');
  await load(a.page, 'https://vk.com/video_ext.php?oid=-123&id=456&hash=kept');
  await b.page.waitForFunction(() => playerReady && currentType === 'vk');
  await a.page.waitForTimeout(1700);
  await a.page.evaluate(() => { vkPlayer.seek(123); vkPlayer.play(); });
  await b.page.waitForFunction(() => vkPlayer?.getCurrentTime() >= 123 && vkPlayer.getState() === 'playing');
  const c = await join('Clara');
  await c.page.waitForFunction(() => playerReady && vkPlayer?.getCurrentTime() >= 123 && vkPlayer.getState() === 'playing');
  await a.page.evaluate(() => vkPlayer.pause());
  await c.page.waitForFunction(() => vkPlayer?.getState() === 'paused');
  assert.ok(await b.page.evaluate(() => document.querySelector('#playerContainer iframe').src.includes('hash=kept')));
  await a.page.fill('#urlInput', 'https://anime.example/watch/12');
  await a.page.click('#loadBtn');
  assert.equal(await a.page.getAttribute('#notice', 'data-kind'), 'error');
});

test('Браузеры: настоящий WebRTC на нескольких зрителей и позднее подключение', { timeout: 60000 }, async (t) => {
  const { join } = await setup(t);
  const a = await join('Alice');
  const b = await join('Bella');
  const c = await join('Clara');
  await a.page.click('#shareScreenBtn');
  await b.page.waitForFunction(() => screenVideo.videoWidth === 160 && screenVideo.readyState >= 2);
  await c.page.waitForFunction(() => screenVideo.videoWidth === 160 && screenVideo.readyState >= 2);
  assert.equal(await a.page.evaluate(() => peers.size), 2);
  const d = await join('Diana');
  await d.page.waitForFunction(() => screenVideo.videoWidth === 160 && screenVideo.readyState >= 2);
  assert.equal(await a.page.evaluate(() => peers.size), 3);
  await c.context.close();
  await a.page.waitForFunction(() => peers.size === 2);
  await a.page.click('#stopScreenBtn');
  await b.page.waitForFunction(() => !screenSession && !screenVideo.srcObject);
  await d.page.waitForFunction(() => !screenSession && !screenVideo.srcObject);
  assert.equal(await a.page.evaluate(() => peers.size), 0);
  assert.equal(await a.page.isVisible('#shareScreenBtn'), true);
});

test('Браузер: ошибка API, повтор загрузки, быстрая смена видео, мобильная вёрстка', { timeout: 45000 }, async (t) => {
  const { join, load } = await setup(t);
  const { page, context } = await join('Mobile');
  await page.setViewportSize({ width: 390, height: 844 });
  await context.route('https://www.youtube.com/iframe_api', (route) => route.abort());
  await page.fill('#urlInput', 'https://youtu.be/dQw4w9WgXcQ');
  await page.click('#loadBtn');
  await page.waitForFunction(() => document.getElementById('notice').dataset.kind === 'error');
  assert.match(await page.textContent('#notice'), /YouTube/);
  // Повтор после ошибки не должен использовать навсегда отклонённый Promise.
  await context.route('https://www.youtube.com/iframe_api', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ contentType: 'text/javascript', body: youtubeSDK });
  });
  await page.click('#loadBtn');
  // VK должен остаться выбранным, даже когда отложенный YouTube API загрузится.
  await load(page, 'https://vk.com/video-123_456');
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => currentType), 'vk');
  assert.equal(await page.locator('#playerContainer iframe').count(), 1);
  assert.equal(await page.evaluate(() => ytPlayer), null);
  await page.fill('#urlInput', 'https://anime.example/not-a-video');
  await page.click('#loadBtn');
  await page.locator('#sendBtn').scrollIntoViewIfNeeded();
  const sendRect = await page.locator('#sendBtn').boundingBox();
  assert.ok(sendRect.y >= 0 && sendRect.y + sendRect.height <= 844);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('Браузер: service worker устанавливается, выдаёт свежий код и открывает страницу офлайн', { timeout: 30000 }, async (t) => {
  const { base, browser } = await setup(t);
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  assert.equal(await page.evaluate(() => caches.has('wt-v3.0.0')), true);
  const response = await page.evaluate(async () => {
    const result = await fetch('/app.js?v=3.0.0');
    return { status: result.status, body: await result.text() };
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /Watch Together 3\.0/);
  await context.setOffline(true);
  await page.goto(base + '/r/offline-room');
  assert.equal(await page.inputValue('#roomInput'), 'offline-room');
  assert.equal(await page.locator('h1').textContent(), 'Watch Together');
  assert.deepEqual(errors, []);
});

test('Браузеры: настоящий видеофайл без CORS-заголовков и синхронизация паузы', { timeout: 30000 }, async (t) => {
  const { browser, join, load } = await setup(t);
  const recorderPage = await browser.newPage();
  const bytes = await recorderPage.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 90;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const done = new Promise((resolve) => { recorder.onstop = resolve; });
    let n = 0;
    const timer = setInterval(() => {
      ctx.fillStyle = n++ % 2 ? '#ff2d78' : '#12121a';
      ctx.fillRect(0, 0, 160, 90);
    }, 50);
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    recorder.stop();
    await done;
    clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()));
  });
  await recorderPage.close();
  const a = await join('Alice');
  const b = await join('Bella');
  for (const client of [a, b]) {
    await client.context.route('https://media.example/fixture.webm', (route) => route.fulfill({ contentType: 'video/webm', body: Buffer.from(bytes) }));
  }
  await load(a.page, 'https://media.example/fixture.webm');
  await b.page.waitForFunction(() => playerReady && currentType === 'file');
  assert.equal(await a.page.evaluate(() => fileVideoEl.getAttribute('crossorigin')), null);
  await a.page.waitForTimeout(1700);
  await a.page.evaluate(() => fileVideoEl.play());
  await b.page.waitForFunction(() => !fileVideoEl.paused);
  await a.page.evaluate(() => fileVideoEl.pause());
  await b.page.waitForFunction(() => fileVideoEl.paused);
  const times = await Promise.all([a, b].map(({ page }) => page.evaluate(() => fileVideoEl.currentTime)));
  assert.ok(Math.abs(times[0] - times[1]) < 0.5);
});
