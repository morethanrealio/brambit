// A website shows the face of an assistant in public mode (docs/public-web.md,
// "Avatar"). The page loads this script from the Brambit server and keeps
// sending its visitor's messages to /api/public/messages as before; while a
// talk is open, the face says each new reply to that contact (the server reads
// the reply itself). The face comes on an Agora channel, watched with the SDK
// this server ships, loaded only when a talk opens. The avatar service bills
// every second a talk is open, so leaving the page hangs up.
//
//   var talk = BrambitAvatar.open({ server: 'https://brambit.example.com', agent: '<agent id>',
//     contact: '<contact token>', video: document.querySelector('video'), sayLatest: true,
//     onState: function (state) {}, onEnd: function (reason) {} });
//   talk.hush();   // the visitor started to type or speak: the face stops
//   talk.end();
//
// A talk the site's own server opened (with its key) is watched with
// BrambitAvatar.watch({ server, agent, id, video, onState, onEnd }).
// States: connecting, ready, tap_to_hear (the browser blocks sound until a
// tap on the video), speech_failed. onEnd gets why the talk ended: the
// server's reason, an error code when it could not open, or hangup.
(function () {
  var SDK = '/vendor/agora-rtc-sdk-ng/AgoraRTC_N-4.24.9.min.js';
  var sdk = null;

  function loadSdk(server) {
    if (!sdk) {
      sdk = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = server + SDK;
        s.onload = function () { resolve(window.AgoraRTC); };
        s.onerror = function () { sdk = null; reject(new Error('sdk')); };
        document.head.appendChild(s);
      });
    }
    return sdk;
  }

  function address(o, path) {
    return o.server.replace(/\/+$/, '') + '/api/public/avatar' + path + '?agent=' + encodeURIComponent(o.agent);
  }

  function post(o, path, body) {
    return fetch(address(o, path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) throw new Error(data.error || String(r.status));
          return data;
        });
      });
  }

  // o: { server, agent, video, onState, onEnd }. → { hush, end }; id = a talk already open.
  function talk(o, opening) {
    var t = { id: '', events: null, client: null, voice: null, over: false };
    var state = function (s) { if (!t.over && o.onState) o.onState(s); };

    function close(reason) {
      if (t.over) return;
      t.over = true;
      if (t.events) t.events.close();
      if (t.client) t.client.leave().catch(function () { /* already out */ });
      if (o.video) o.video.srcObject = null;
      window.removeEventListener('pagehide', hangUp);
      if (o.onEnd) o.onEnd(reason);
    }

    function stop(reason) {
      if (t.over) return;
      var id = t.id;
      close(reason);
      // A page that closes cannot wait for an answer; a beacon is sent as text, with no preflight.
      if (id && !(navigator.sendBeacon && navigator.sendBeacon(address(o, '/end'), JSON.stringify({ id: id })))) {
        fetch(address(o, '/end'), { method: 'POST', body: JSON.stringify({ id: id }), keepalive: true }).catch(function () { /* it ends alone */ });
      }
    }

    function hangUp() { stop('hangup'); }

    function join(rtc) {
      if (t.client || t.over) return;
      loadSdk(o.server.replace(/\/+$/, '')).then(function (AgoraRTC) {
        if (t.over || t.client) return;
        AgoraRTC.setLogLevel(3);
        AgoraRTC.onAutoplayFailed = function () { state('tap_to_hear'); };
        var client = t.client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
        client.on('user-published', function (user, kind) {
          client.subscribe(user, kind).then(function () {
            if (t.over) return;
            if (kind === 'video') {
              if (o.video) {
                o.video.srcObject = new MediaStream([user.videoTrack.getMediaStreamTrack()]);
                o.video.play().catch(function () { /* muted video always plays */ });
              }
            } else {
              t.voice = user.audioTrack;
              t.voice.play();
            }
          });
        });
        return client.join(rtc.appId, rtc.channel, rtc.token, rtc.uid);
      }).catch(function () { stop('error'); });
    }

    function watch(id) {
      t.id = id;
      if (t.over) { hangUpLate(id); return; }
      var ev = t.events = new EventSource(address(o, '/events') + '&id=' + encodeURIComponent(id));
      ev.addEventListener('rtc', function (e) { join(JSON.parse(e.data)); });
      ev.addEventListener('ready', function () { state('ready'); });
      ev.addEventListener('end', function (e) { close(JSON.parse(e.data).reason); });
      // A speech that failed (data from the server), or the stream that dropped for good.
      ev.addEventListener('error', function (e) {
        if (e.data) state('speech_failed');
        else if (ev.readyState === EventSource.CLOSED) close('error');
      });
    }
    // Hung up while the talk was opening: it ends at once instead of waiting to be unwatched.
    function hangUpLate(id) { post(o, '/end', { id: id }).catch(function () { /* it ends alone */ }); }

    if (o.video) o.video.addEventListener('click', function () { if (t.voice && !t.over) { t.voice.play(); state('ready'); } });
    window.addEventListener('pagehide', hangUp);
    state('connecting');
    opening.then(watch, function (e) { close(e.message || 'error'); });

    return {
      hush: function () { if (t.id && !t.over) post(o, '/hush', { id: t.id }).catch(function () { /* the next reply goes on */ }); },
      end: hangUp,
    };
  }

  window.BrambitAvatar = {
    // A contact of this browser (the token from /api/public/messages) talks to the face.
    // sayLatest: the face first says the reply already on the page.
    open: function (o) {
      return talk(o, post(o, '', { contact: o.contact, sayLatest: !!o.sayLatest }).then(function (d) { return d.id; }));
    },
    watch: function (o) { return talk(o, Promise.resolve(o.id)); },
  };
})();
