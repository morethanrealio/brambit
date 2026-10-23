// Talking to an assistant's avatar in the open chat (index.html: the face
// button in the chat head opens #avLive above the messages). While the talk is
// open, each new assistant reply in the chat is said by the face; the server
// reads the reply itself (web/avatar-live.mjs), the page only says "there is a
// new one". The face comes on an Agora channel, watched with the vendored SDK
// (vendor/agora-rtc-sdk-ng), loaded only when a talk opens. The avatar service
// bills every second a talk is open, so leaving the chat or the page hangs up.
// Texts come from the catalogs' index_script.avatar_live.* (page-texts.js).
(function () {
  var SDK = '/vendor/agora-rtc-sdk-ng/AgoraRTC_N-4.24.9.min.js';
  var ENDS = ['idle', 'max', 'daily', 'credit', 'provider', 'error', 'unwatched', 'replaced', 'changed', 'removed', 'avatar_not_ready', 'shutdown'];
  var tx = function (key) { return window.pageText('avatar_live.' + key); };
  var $ = function (id) { return document.getElementById(id); };
  var chat = { agentId: '', threadId: '' };
  var talk = null;   // {id, agentId, threadId, events, client, voice}
  var sdk = null;
  var asked = 0;

  async function api(path, opts) {
    var r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
    var data = null;
    try { data = await r.json(); } catch (e) { /* noop */ }
    if (r.status === 401) { window.location.href = '/login'; throw new Error('unauth'); }
    if (!r.ok) throw new Error((data && data.error) || String(r.status));
    return data;
  }

  function status(text, err) {
    var el = $('avLiveStatus');
    el.textContent = text || '';
    el.classList.toggle('err', !!err);
  }

  function loadSdk() {
    if (!sdk) {
      sdk = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = SDK;
        s.onload = function () { resolve(window.AgoraRTC); };
        s.onerror = function () { sdk = null; reject(new Error('sdk')); };
        document.head.appendChild(s);
      });
    }
    return sdk;
  }

  // The button shows only for an assistant whose avatar is ready.
  function offer(agentId) {
    var n = ++asked;
    $('avLiveBtn').classList.add('hidden');
    if (!agentId) return;
    api('/api/agent/avatar?agentId=' + encodeURIComponent(agentId)).then(function (d) {
      if (n === asked) $('avLiveBtn').classList.toggle('hidden', !(d.available && d.avatar && d.avatar.status === 'ready'));
    }).catch(function () { /* no button */ });
  }

  // The face goes away; the panel stays only to show why, when there is a reason.
  function close(t, text, err) {
    if (t !== talk) return;
    talk = null;
    if (t.events) t.events.close();
    if (t.client) t.client.leave().catch(function () { /* already out */ });
    $('avFace').srcObject = null;
    $('avLiveBtn').classList.remove('on');
    $('avLiveEnd').classList.add('hidden');
    if (text) status(text, err);
    else $('avLive').classList.add('hidden');
  }

  function hangUp() {
    var t = talk;
    if (!t) return;
    close(t);
    if (t.id) fetch('/api/agent/avatar/live?id=' + encodeURIComponent(t.id), { method: 'DELETE', keepalive: true }).catch(function () { /* it ends alone */ });
  }

  async function join(t, rtc) {
    if (t.client || t !== talk) return;
    try {
      var AgoraRTC = await loadSdk();
      if (t !== talk || t.client) return;
      AgoraRTC.setLogLevel(3);
      // A browser that blocks sound until a tap: the next tap on the face plays it.
      AgoraRTC.onAutoplayFailed = function () { if (t === talk) status(tx('tap_to_hear')); };
      var client = t.client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      client.on('user-published', async function (user, kind) {
        await client.subscribe(user, kind);
        if (t !== talk) return;
        if (kind === 'video') {
          $('avFace').srcObject = new MediaStream([user.videoTrack.getMediaStreamTrack()]);
          $('avFace').play().catch(function () { /* muted video always plays */ });
        } else {
          t.voice = user.audioTrack;
          t.voice.play();
        }
      });
      await client.join(rtc.appId, rtc.channel, rtc.token, rtc.uid);
    } catch (e) {
      console.error('[avatar-live]', e && e.message);
      hangUp();
      $('avLive').classList.remove('hidden');
      status(tx('failed'), true);
    }
  }

  async function start() {
    if (talk || !chat.threadId) return;
    var t = talk = { id: '', agentId: chat.agentId, threadId: chat.threadId, events: null, client: null, voice: null };
    $('avLive').classList.remove('hidden');
    $('avLiveBtn').classList.add('on');
    $('avLiveEnd').classList.remove('hidden');
    status(tx('connecting'));
    try {
      var d = await api('/api/agent/avatar/live', { method: 'POST', body: JSON.stringify({ agentId: t.agentId, threadId: t.threadId }) });
      t.id = d.id;
      if (t !== talk) { fetch('/api/agent/avatar/live?id=' + encodeURIComponent(d.id), { method: 'DELETE' }); return; }
      var ev = t.events = new EventSource('/api/agent/avatar/live/events?id=' + encodeURIComponent(t.id));
      ev.addEventListener('rtc', function (e) { join(t, JSON.parse(e.data)); });
      ev.addEventListener('ready', function () { if (t === talk) status(tx('ready')); });
      ev.addEventListener('end', function (e) {
        var reason = JSON.parse(e.data).reason;
        close(t, ENDS.indexOf(reason) >= 0 ? tx('end.' + reason) : '', reason !== 'hangup');
      });
      // A speech that failed (data from the server), or the stream that dropped for good.
      ev.addEventListener('error', function (e) {
        if (t !== talk) return;
        if (e.data) status(tx('speech_failed'), true);
        else if (ev.readyState === EventSource.CLOSED) close(t, tx('end.error'), true);
      });
    } catch (e) {
      close(t, e.message, true);
    }
  }

  function post(path) {
    if (talk && talk.id) api('/api/agent/avatar/live/' + path, { method: 'POST', body: JSON.stringify({ id: talk.id }) }).catch(function () { /* the next reply tries again */ });
  }

  $('avLiveBtn').addEventListener('click', function () { if (talk) hangUp(); else start(); });
  $('avLiveEnd').addEventListener('click', hangUp);
  $('avFace').addEventListener('click', function () {
    if (talk && talk.voice) { talk.voice.play(); status(tx('ready')); }
  });
  window.addEventListener('pagehide', hangUp);

  window.avatarLive = {
    // A chat opened (or the same one again): another chat hangs up the talk.
    chat: function (agentId, threadId) {
      if (talk && (talk.agentId !== agentId || talk.threadId !== threadId)) hangUp();
      chat = { agentId: agentId || '', threadId: threadId || '' };
      if (!talk) $('avLive').classList.add('hidden');
      offer(chat.agentId);
    },
    leave: function () { hangUp(); $('avLive').classList.add('hidden'); },
    // A new assistant reply is on screen: the face says it.
    replied: function (threadId) { if (talk && talk.threadId === threadId) post('speak'); },
    // The person started to speak: the face stops.
    hush: function () { post('hush'); },
  };
})();
