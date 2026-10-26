// One editable text with its saved versions (public-support-prompts.mjs), used
// by the admin settings and the public-support screens. The box opens with the
// current text, or with the default when nothing was edited; saving the default
// itself, or the back-to-default button, stores "no edit".
//
// textHistory(mount, { api, rows, labelledBy }) where api = { load(), save(content),
// restore(versionId) }, each resolving to the server's text state
// { content, default, max, versions: [{ id, content, createdAt }] } or throwing
// an Error whose `code` is the server's error. Texts come from the page's
// text_history area (data-i18n-texts). Everything is put on the page as text,
// never as HTML.
(function () {
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function button(cls, text, onClick) {
    var b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  window.textHistory = function (mount, opts) {
    var t = window.pageText;
    var lang = document.documentElement.lang || undefined;
    var number = new Intl.NumberFormat(lang);
    var when = function (iso) { return new Date(iso).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' }); };
    var state = null;
    var busy = false;

    var box = el('textarea', 'th-box');
    box.rows = opts.rows || 14;
    box.spellcheck = false;
    if (opts.labelledBy) box.setAttribute('aria-labelledby', opts.labelledBy);
    var count = el('span', 'th-count');
    var tag = el('span', 'th-tag');
    var result = el('span', 'th-result');
    var saveButton = button('', t('history_save'), function () { send(function () { return opts.api.save(box.value); }); });
    var resetButton = button('ghost', t('history_reset'), function () {
      if (confirm(t('history_reset_confirm'))) send(function () { return opts.api.save(''); });
    });
    var versions = el('details', 'th-versions');
    var meta = el('div', 'th-meta');
    meta.append(count, tag);
    var actions = el('div', 'th-actions');
    actions.append(saveButton, resetButton, result);

    function refresh() {
      var length = box.value.trim().length;
      count.textContent = t('history_count', { count: number.format(length), max: number.format(state.max) });
      count.classList.toggle('th-over', length > state.max);
      var saved = state.content || state.default;
      var changed = box.value.trim() !== saved.trim();
      tag.textContent = changed ? t('history_unsaved') : state.content ? '' : t('history_using_default');
      saveButton.disabled = busy || !changed;
      resetButton.disabled = busy || !state.content;
    }

    function showVersions() {
      var list = state.versions;
      var summary = el('summary', '', t('history_versions', { count: list.length }));
      versions.replaceChildren(summary);
      if (!list.length) { versions.append(el('p', 'th-none', t('history_none'))); return; }
      list.forEach(function (v, i) {
        var row = el('div', 'th-version');
        var head = el('div', 'th-version-head');
        head.append(el('span', 'th-when', when(v.createdAt)));
        if (!v.content) head.append(el('span', 'th-tag', t('history_version_default')));
        if (i === 0) head.append(el('span', 'th-tag', t('history_version_current')));
        var full = el('pre', 'th-full', v.content || state.default);
        full.hidden = true;
        var view = button('ghost', t('history_view'), function () {
          full.hidden = !full.hidden;
          view.textContent = full.hidden ? t('history_view') : t('history_hide');
        });
        head.append(view);
        if (i > 0) head.append(button('ghost', t('history_restore'), function () {
          if (confirm(t('history_restore_confirm', { date: when(v.createdAt) }))) send(function () { return opts.api.restore(v.id); });
        }));
        row.append(head, full);
        versions.append(row);
      });
    }

    // The box only goes on the page once there is a text to show and save.
    function show(next) {
      if (!state) mount.replaceChildren(box, meta, actions, versions);
      state = next;
      box.maxLength = state.max;
      box.value = state.content || state.default;
      showVersions();
      refresh();
    }

    function send(call) {
      if (box.value.trim().length > state.max) { result.className = 'th-result err'; result.textContent = t('history_too_long', { max: number.format(state.max) }); return; }
      busy = true;
      refresh();
      result.className = 'th-result';
      result.textContent = t('history_saving');
      call().then(function (next) {
        show(next);
        result.className = 'th-result ok';
        result.textContent = t('history_saved');
      }, function (e) {
        result.className = 'th-result err';
        result.textContent = e && e.code === 'too_long' ? t('history_too_long', { max: number.format(state.max) }) : t('history_failed');
      }).then(function () { busy = false; refresh(); });
    }

    box.addEventListener('input', function () { result.textContent = ''; refresh(); });
    return opts.api.load().then(show);
  };
})();
