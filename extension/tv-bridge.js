// Runs on the Karaoke Night TV page and passes messages between the page and the extension.
// It only switches on for pages that identify themselves as Karaoke Night.
(() => {
  const FROM_PAGE = 'karaoke-night-tv';
  const TO_PAGE = 'karaoke-night-ext';
  let active = false;

  const isKaraokeNight = () =>
    document.querySelector('meta[name="application-name"]')?.content === 'Karaoke Night';

  const announce = () => {
    if (active) window.postMessage({ source: TO_PAGE, type: 'ready', version: chrome.runtime.getManifest().version }, '*');
  };

  function start() {
    if (active || !isKaraokeNight()) return;
    active = true;
    chrome.runtime.sendMessage({ from: 'tv', type: 'register' }).catch(() => {});
    announce();
  }

  window.addEventListener('message', e => {
    if (e.source !== window || e.data?.source !== FROM_PAGE) return;
    if (e.data.type === 'hello') { start(); announce(); return; }
    if (!active) return;
    chrome.runtime.sendMessage({ ...e.data, from: 'tv' }).catch(() => {});
  });

  // Status, "ended", errors and keys from the YouTube tab, relayed by the background script.
  chrome.runtime.onMessage.addListener(msg => {
    if (active) window.postMessage({ ...msg, source: TO_PAGE }, '*');
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
