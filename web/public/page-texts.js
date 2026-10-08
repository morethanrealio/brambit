// Texts for a page's own script (docs/i18n.md, "Pages"). The server fills
// <script type="application/json" data-i18n-texts="<area>"> with the area's
// texts in the page's language; pageText('key', {name: value}) reads them.
// A plural key comes as key_one/key_other...: pass `count` and the form is
// picked with the language's rules.
(function () {
  var texts = {};
  var blocks = document.querySelectorAll('script[data-i18n-texts]');
  for (var i = 0; i < blocks.length; i++) {
    try { Object.assign(texts, JSON.parse(blocks[i].textContent || '{}')); } catch (e) { /* key shows instead */ }
  }
  var plural = new Intl.PluralRules(document.documentElement.lang || 'en');
  window.pageText = function (key, vars) {
    vars = vars || {};
    var text = texts[key];
    if (text == null && typeof vars.count === 'number') text = texts[key + '_' + plural.select(vars.count)] ?? texts[key + '_other'];
    if (text == null) text = key;
    return text.replace(/\{(\w+)\}/g, function (m, name) { return name in vars ? vars[name] : m; });
  };
})();
