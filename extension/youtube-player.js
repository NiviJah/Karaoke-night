// Runs on youtube.com, but only takes over the tab the Karaoke Night extension opened:
// the player fills the screen, YouTube's buttons are hidden, progress goes back to the TV,
// and the TV is told when the song ends.
(async () => {
  const ask = msg => chrome.runtime.sendMessage({ ...msg, from: 'youtube' }).catch(() => null);

  let mine = null;
  for (let i = 0; i < 20 && !mine?.karaoke; i++) {
    mine = await ask({ type: 'whoami' });
    if (!mine?.karaoke) await new Promise(r => setTimeout(r, 300));
  }
  if (!mine?.karaoke) return;

  const style = document.createElement('style');
  style.textContent = `
    html, body { background: #000 !important; overflow: hidden !important; }
    #masthead-container { display: none !important; }
    #movie_player { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
      z-index: 2147483000 !important; background: #000 !important; }
    #movie_player .html5-video-container { width: 100% !important; height: 100% !important; }
    #movie_player video.html5-main-video { position: absolute !important; left: 0 !important; top: 0 !important;
      width: 100vw !important; height: 100vh !important; object-fit: contain !important; }
    #movie_player .ytp-chrome-top, #movie_player .ytp-chrome-bottom, #movie_player .ytp-gradient-top,
    #movie_player .ytp-gradient-bottom, #movie_player .ytp-ce-element, #movie_player .ytp-pause-overlay,
    #movie_player .ytp-watermark, #movie_player .iv-branding, #movie_player .ytp-autonav-endscreen-countdown-overlay,
    #movie_player .ytp-endscreen-content { display: none !important; }
    #kn-click { position: fixed; inset: 0; z-index: 2147483600; display: grid; place-content: center; text-align: center;
      background: rgba(16, 14, 28, .9); color: #ffb547; font: 800 6vh/1.3 system-ui, sans-serif; cursor: pointer; }
    #kn-click small { display: block; color: #ece9fb; font-weight: 500; font-size: 3vh; }
    #kn-back { position: fixed; top: 3vh; left: 3vh; z-index: 2147483500; padding: 1.4vh 2.4vh; border: 0; border-radius: 1.2vh;
      background: rgba(16, 14, 28, .88); color: #ffb547; font: 700 2.6vh/1 system-ui, sans-serif; cursor: pointer;
      opacity: 0; transition: opacity .3s; }
    #kn-back small { color: #ece9fb; font-weight: 500; margin-left: 1vh; }
    html.kn-show #kn-back, #kn-back:focus-visible { opacity: 1; }
    html:not(.kn-show) { cursor: none; }
  `;
  (document.head || document.documentElement).append(style);

  const startId = mine.videoId;
  const started = Date.now();
  let video = null, done = false, userPaused = false, playedOnce = false;
  const player = () => document.getElementById('movie_player');
  const isAd = () => !!player()?.classList.contains('ad-showing');
  const currentId = () => new URL(location.href).searchParams.get('v');

  function finish(type, extra) {
    if (done) return;
    done = true;
    ask({ type, ...extra });
  }

  function attach() {
    const v = document.querySelector('#movie_player video.html5-main-video') || document.querySelector('#movie_player video');
    if (v && v !== video) {
      video = v;
      video.addEventListener('ended', () => { if (!isAd()) finish('ended'); });
      video.addEventListener('playing', () => { if (!isAd()) playedOnce = true; document.getElementById('kn-click')?.remove(); });
    }
  }

  // YouTube often just stops at the end without firing "ended": also check its own ended state
  // (the player's ended-mode class) and a video sitting paused at its last moment.
  const atEnd = () => {
    if (!video || isAd()) return false;
    if (player()?.classList.contains('ended-mode')) return true;
    const d = video.duration;
    return d > 0 && isFinite(d) && video.paused && video.currentTime >= d - 0.75;
  };

  // "Back to Karaoke Night": ends this YouTube song early and returns to the app. Shows when the mouse moves.
  const back = document.createElement('button');
  back.id = 'kn-back';
  back.innerHTML = '← Back to Karaoke Night<small>(B)</small>';
  back.addEventListener('click', () => finish('key', { key: 'skip' }));
  document.documentElement.append(back);
  let hideTimer;
  document.addEventListener('mousemove', () => {
    document.documentElement.classList.add('kn-show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => document.documentElement.classList.remove('kn-show'), 3000);
  }, true);

  // If Chrome blocked autoplay with sound, one click on the TV starts it.
  function askForClick() {
    if (document.getElementById('kn-click')) return;
    const o = document.createElement('div');
    o.id = 'kn-click';
    o.innerHTML = 'Click to start the song<small>Tip: allow Sound for youtube.com so this isn\'t needed (see the README)</small>';
    o.addEventListener('click', () => { video?.play(); o.remove(); });
    document.documentElement.append(o);
  }

  setInterval(() => {
    attach();
    if (done) return;
    // YouTube moved on to another video by itself: treat our song as finished.
    if (startId && currentId() && currentId() !== startId) return finish('ended');
    const err = document.querySelector('#movie_player .ytp-error');
    if (err && err.offsetParent !== null) {
      return finish('error', { reason: (err.textContent || 'YouTube can\'t play this video.').replace(/\s+/g, ' ').trim().slice(0, 160) });
    }
    if (!video) return;
    if (playedOnce && atEnd()) return finish('ended');
    if (!playedOnce && video.paused && !isAd() && !userPaused && Date.now() - started > 5000) {
      video.play().catch(askForClick);
    }
    const ad = isAd();
    ask({ type: 'status', time: ad ? 0 : video.currentTime, duration: ad ? 0 : (video.duration || 0), paused: video.paused, ad });
  }, 1000);

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type !== 'command' || !video) return;
    if (msg.action === 'pause') { userPaused = true; video.pause(); }
    else if (msg.action === 'resume') { userPaused = false; video.play().catch(askForClick); }
    else if (msg.action === 'restart') { video.currentTime = 0; video.play().catch(askForClick); }
  });

  // N (next singer, as on the TV page) or B (back to Karaoke Night) ends the song. Space already pauses YouTube.
  document.addEventListener('keydown', e => {
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    if (['n', 'N', 'b', 'B'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); finish('key', { key: 'skip' }); }
  }, true);
})();
