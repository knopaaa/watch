// Один разбор ссылок для браузера и сервера.
(function (root) {
  function parse(input) {
    if (typeof input !== 'string' || input.length > 4096) return null;
    const iframe = input.match(/<iframe\b[^>]*\bsrc=["']([^"']+)["']/i);
    let url;
    try { url = new URL(iframe ? iframe[1].replace(/&amp;/g, '&') : input.trim()); }
    catch { return null; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    const isHost = (domain) => host === domain || host.endsWith('.' + domain);
    if (isHost('youtube.com') || isHost('youtube-nocookie.com') || host === 'youtu.be') {
      const id = host === 'youtu.be' ? url.pathname.split('/')[1]
        : url.pathname === '/watch' ? url.searchParams.get('v')
          : url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)/)?.[1];
      return /^[\w-]{11}$/.test(id || '') ? { type: 'youtube', id, url: url.href } : null;
    }
    if (['vk.com', 'vk.ru', 'vkvideo.com', 'vkvideo.ru'].some(isHost)) {
      let embed;
      if (/^\/video_(?:ext|embed)\.php$/.test(url.pathname)) {
        if (!/^-?\d+$/.test(url.searchParams.get('oid') || '') ||
            !/^\d+$/.test(url.searchParams.get('id') || '')) return null;
        embed = new URL(url);
        embed.protocol = 'https:';
      } else {
        const match = (url.pathname + ' ' + (url.searchParams.get('z') || ''))
          .match(/(?:^|[ /])video(-?\d+)_(\d+)/);
        if (!match) return null;
        embed = new URL('/video_ext.php', 'https://' + (isHost('vkvideo.ru') ? 'vkvideo.ru' : 'vk.com'));
        embed.search = new URLSearchParams({ oid: match[1], id: match[2], hd: '2' }).toString();
      }
      embed.searchParams.set('js_api', '1');
      embed.searchParams.set('autoplay', '0');
      return { type: 'vk', id: embed.href, url: url.href };
    }
    if (/\.(?:mp4|webm|ogv|ogg|m4v|m3u8)$/i.test(url.pathname)) {
      return { type: 'file', id: url.href, url: url.href };
    }
    return null;
  }
  const api = { parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WatchVideo = api;
})(typeof window !== 'undefined' ? window : globalThis);
