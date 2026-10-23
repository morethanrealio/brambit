// The Avatar card of the assistant settings (index.html, #avCard): the face
// photo, whose face it is and the voice. The server side is web/avatar.mjs.
// The card stays hidden when the installation has no avatar service. Texts come
// from the catalogs' index_script.avatar.* (page-texts.js).
(function () {
  var tx = function (key, vars) { return window.pageText('avatar.' + key, vars); };
  var $ = function (id) { return document.getElementById(id); };
  var agentId = '';
  var avatar = null;
  var newPhoto = null;
  var pollTimer = null;

  function setMsg(text, err) { var el = $('avMsg'); el.textContent = text || ''; el.className = 'm-msg' + (err ? ' m-err' : ''); }

  async function api(path, opts) {
    var r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
    var data = null;
    try { data = await r.json(); } catch (e) { /* noop */ }
    if (r.status === 401) { window.location.href = '/login'; throw new Error('unauth'); }
    if (!r.ok) throw new Error((data && data.error) || String(r.status));
    return data;
  }

  // The photo leaves the browser as a JPEG of at most 1280 px: smaller to send,
  // and the format the avatar service is known to take.
  function toJpeg(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = reject;
      reader.onload = function () {
        var img = new Image();
        img.onerror = reject;
        img.onload = function () {
          var w = img.width, h = img.height, max = 1280;
          if (w > max || h > max) { var s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
          var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          var url = cv.toDataURL('image/jpeg', 0.9);
          resolve({ url: url, data: url.split(',')[1] });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function statusText(a) {
    if (!a) return tx('none');
    if (a.status === 'ready') return tx('ready');
    if (a.status === 'failed') return tx('rejected');
    if (a.status === 'pending' && a.error) return tx('retrying');
    return tx(a.status === 'registering' ? 'registering' : 'pending');
  }

  function fillVoices(voices, chosen) {
    var sel = $('avVoice');
    sel.textContent = '';
    voices.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.style ? tx('voice_option', { voice: v.id, style: tx('style.' + v.style) }) : v.id;
      sel.appendChild(o);
    });
    sel.value = chosen;
  }

  function show(a) {
    avatar = a;
    $('avPreview').style.display = a ? '' : 'none';
    if (a) $('avPreview').src = a.photoUrl;
    else $('avPreview').removeAttribute('src');
    $('avStatus').textContent = statusText(a);
    $('avRemoveBtn').style.display = a ? '' : 'none';
    clearTimeout(pollTimer);
    // Registration runs on the server; the card follows it until it settles.
    if (a && (a.status === 'registering' || (a.status === 'pending' && !a.error))) {
      var forAgent = agentId;
      pollTimer = setTimeout(function () {
        if (forAgent !== agentId) return;
        api('/api/agent/avatar?agentId=' + encodeURIComponent(forAgent)).then(function (d) {
          if (forAgent === agentId && d.available) show(d.avatar);
        }).catch(function () { /* the next render tries again */ });
      }, 3000);
    }
  }

  function render(id) {
    agentId = id || '';
    newPhoto = null;
    clearTimeout(pollTimer);
    setMsg('');
    $('avPhoto').value = '';
    if (!agentId) { $('avCard').style.display = 'none'; return; }
    api('/api/agent/avatar?agentId=' + encodeURIComponent(agentId)).then(function (d) {
      if (!d.available) { $('avCard').style.display = 'none'; return; }
      $('avCard').style.display = '';
      fillVoices(d.voices || [], (d.avatar && d.avatar.voice) || d.defaultVoice);
      $('avConsent').value = (d.avatar && d.avatar.consent) || '';
      show(d.avatar);
    }).catch(function (e) { $('avCard').style.display = 'none'; console.error('[avatar]', e.message); });
  }

  $('avPhoto').addEventListener('change', function () {
    var file = this.files && this.files[0];
    if (!file) return;
    setMsg('');
    toJpeg(file).then(function (p) {
      newPhoto = p;
      $('avPreview').src = p.url;
      $('avPreview').style.display = '';
    }).catch(function () { newPhoto = null; setMsg(tx('read_failed'), true); });
  });

  $('avListenBtn').addEventListener('click', function () {
    var audio = $('avAudio');
    audio.src = '/api/agent/avatar/voice-sample?voice=' + encodeURIComponent($('avVoice').value);
    audio.play().catch(function () { /* the error event explains */ });
  });
  $('avAudio').addEventListener('error', function () { setMsg(tx('listen_failed'), true); });

  $('avSaveBtn').addEventListener('click', function () {
    if (!agentId) return;
    if (!avatar && !newPhoto) { setMsg(tx('pick_photo'), true); return; }
    if (!$('avConsent').value) { setMsg(tx('pick_consent'), true); return; }
    var body = { agentId: agentId, consent: $('avConsent').value, voice: $('avVoice').value };
    if (newPhoto) body.photo = { mimeType: 'image/jpeg', data: newPhoto.data };
    var forAgent = agentId;
    $('avSaveBtn').disabled = true;
    api('/api/agent/avatar', { method: 'POST', body: JSON.stringify(body) }).then(function (d) {
      if (forAgent !== agentId) return;
      newPhoto = null;
      $('avPhoto').value = '';
      setMsg(tx('saved'));
      show(d.avatar);
    }).catch(function (e) { setMsg(e.message, true); }).finally(function () { $('avSaveBtn').disabled = false; });
  });

  $('avRemoveBtn').addEventListener('click', function () {
    if (!agentId || !window.confirm(tx('remove_confirm'))) return;
    var forAgent = agentId;
    api('/api/agent/avatar?agentId=' + encodeURIComponent(forAgent), { method: 'DELETE' }).then(function (d) {
      if (forAgent !== agentId) return;
      $('avConsent').value = '';
      show(null);
      setMsg(tx(d.providerDeleted ? 'removed' : 'removed_later'));
    }).catch(function (e) { setMsg(e.message, true); });
  });

  window.avatarSettings = { render: render };
})();
