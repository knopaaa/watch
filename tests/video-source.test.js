const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../public/video-source');

test('YouTube: порядок параметров, короткие ссылки, shorts', () => {
  for (const url of [
    'https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=25',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ'
  ]) assert.equal(parse(url).id, 'dQw4w9WgXcQ');
});
test('VK: отрицательный owner, hash в embed, z-ссылки и код iframe', () => {
  const publicVideo = parse('https://vkvideo.ru/video-123_456');
  assert.equal(publicVideo.type, 'vk');
  assert.equal(new URL(publicVideo.id).searchParams.get('oid'), '-123');
  assert.equal(parse('https://vk.com/videos-123?z=video-123_456%2Fclub123').type, 'vk');
  const embed = parse('<iframe src="https://vk.com/video_ext.php?oid=-123&amp;id=456&amp;hash=secret"></iframe>');
  const url = new URL(embed.id);
  assert.equal(url.searchParams.get('hash'), 'secret');
  assert.equal(url.searchParams.get('js_api'), '1');
  assert.equal(url.searchParams.get('autoplay'), '0');
});
test('Поддерживаются прямые файлы, неизвестные страницы и опасные схемы отклоняются', () => {
  assert.equal(parse('https://media.example/test.m3u8?token=abc').type, 'file');
  for (const value of [null, {}, 'javascript:alert(1)', 'file:///test.mp4',
    'https://anime.example/watch/12', 'https://fake-youtube.com/watch?v=dQw4w9WgXcQ',
    'https://vk.com/video_ext.php?oid=no&id=3', 'https://user:pass@media.example/test.mp4']) {
    assert.equal(parse(value), null);
  }
});
