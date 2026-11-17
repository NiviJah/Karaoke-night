// Keeps track of the Karaoke Night TV tab and the YouTube tab it plays songs in,
// switches between them, and passes messages back and forth.
// Tab ids live in session storage because Chrome stops idle background scripts.

const load = () => chrome.storage.session.get(['tvTab', 'ytTab']);
const save = values => chrome.storage.session.set(values);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, err => reply({ error: String(err) }));
  return true; // reply asynchronously
});

async function handle(msg, sender) {
  const tab = sender.tab;
  if (!tab) return {};
  const s = await load();

  if (msg.from === 'tv') {
    if (msg.type === 'register') { await save({ tvTab: tab.id }); return { ok: true }; }
    if (msg.type === 'play') return play(msg.videoId, tab);
    if (msg.type === 'stop') return stop(s, tab);
    if (msg.type === 'fullscreen') return fullscreen(tab.windowId, msg.toggle);
    if (msg.type === 'command' && s.ytTab) {
      await chrome.tabs.sendMessage(s.ytTab, { type: 'command', action: msg.action }).catch(() => {});
    }
    return { ok: true };
  }

  if (msg.from === 'youtube') {
    // Only the tab this extension opened is driven; ordinary YouTube browsing is left alone.
    if (msg.type === 'whoami') return { karaoke: tab.id === s.ytTab, videoId: s.videoId };
    if (tab.id !== s.ytTab || !s.tvTab) return {};
    await chrome.tabs.sendMessage(s.tvTab, msg).catch(() => {}); // status / ended / error / key
    return { ok: true };
  }
  return {};
}

async function play(videoId, tvTab) {
  if (!/^[\w-]{11}$/.test(videoId || '')) return { error: 'bad video id' };
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const s = await load();
  let yt = s.ytTab ? await chrome.tabs.get(s.ytTab).catch(() => null) : null;
  if (yt && yt.windowId === tvTab.windowId) {
    await save({ tvTab: tvTab.id, videoId });
    await chrome.tabs.update(yt.id, { url, active: true });
  } else {
    // Save the new tab's id before YouTube's script asks whether it's ours.
    yt = await chrome.tabs.create({ windowId: tvTab.windowId, index: tvTab.index + 1, url: 'about:blank', active: false });
    await save({ tvTab: tvTab.id, ytTab: yt.id, videoId });
    await chrome.tabs.update(yt.id, { url, active: true });
  }
  await keepFullscreen(tvTab.windowId);
  return { ok: true };
}

// The whole window goes full screen (like F11), so it stays full screen as we switch between the TV tab
// and the YouTube tab. Leaving a page's own full screen can put the window back to normal a moment
// after a tab switch, so check again shortly after.
async function fullscreen(windowId, toggle) {
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (!win) return { ok: false };
  const state = toggle && win.state === 'fullscreen' ? 'maximized' : 'fullscreen';
  await chrome.windows.update(windowId, { state }).catch(() => {});
  return { ok: true, state };
}
async function keepFullscreen(windowId) {
  for (const wait of [0, 500, 1500]) {
    await new Promise(r => setTimeout(r, wait));
    const win = await chrome.windows.get(windowId).catch(() => null);
    if (win && win.state !== 'fullscreen') await chrome.windows.update(windowId, { state: 'fullscreen' }).catch(() => {});
  }
}

async function stop(s, tvTab) {
  if (s.ytTab) await chrome.tabs.update(s.ytTab, { url: 'about:blank' }).catch(() => {});
  await chrome.tabs.update(tvTab.id, { active: true }).catch(() => {});
  keepFullscreen(tvTab.windowId);
  return { ok: true };
}

chrome.tabs.onRemoved.addListener(async id => {
  const s = await load();
  if (id === s.ytTab) {
    await save({ ytTab: null });
    if (s.tvTab) chrome.tabs.sendMessage(s.tvTab, { type: 'error', reason: 'The YouTube tab was closed.' }).catch(() => {});
  }
});
