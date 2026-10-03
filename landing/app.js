/* ModESP Cloud landing — plain JS, no build, no inline scripts or styles (CSP). */
(function () {
  'use strict';

  // Old app links (https://modesp.com.ua/#/…) still work: the WebUI lives at /cloud/.
  if (location.hash && location.hash.indexOf('#/') === 0) {
    location.replace('/cloud/' + location.hash);
    return;
  }

  var cfg = window.MODESP_LANDING || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // Server-specific values from config.js: an empty value hides the element.
  function applyConfig() {
    $$('[data-cfg]').forEach(function (el) {
      var key = el.getAttribute('data-cfg');
      var val = cfg[key];
      if (!val) { el.hidden = true; return; }
      if (el.tagName === 'A') el.href = key === 'contactEmail' ? 'mailto:' + val : val;
      if (el.hasAttribute('data-cfg-text')) el.textContent = val;
    });
    $$('[data-year]').forEach(function (y) { y.textContent = String(new Date().getFullYear()); });
  }

  // Mobile navigation.
  function nav() {
    var btn = $('.nav-toggle'), menu = $('#nav');
    if (!btn || !menu) return;
    var set = function (open) { menu.classList.toggle('open', open); btn.setAttribute('aria-expanded', open ? 'true' : 'false'); };
    btn.addEventListener('click', function () { set(!menu.classList.contains('open')); });
    $$('a', menu).forEach(function (a) { a.addEventListener('click', function () { set(false); }); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
  }

  // The request form: stored by the backend first, then e-mailed; `website` is a honeypot.
  function form() {
    var f = $('#pilot-form'); if (!f) return;
    var msg = $('#pilot-msg');
    var say = function (cls, text) { msg.className = 'form-msg ' + cls; msg.textContent = text; };
    var segment = new URLSearchParams(location.search).get('segment');
    if (segment && f.segment && $$('option', f.segment).some(function (o) { return o.value === segment; })) f.segment.value = segment;

    f.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!f.name.value.trim() || !f.email.value.trim()) { say('err', 'Вкажіть ім’я та електронну пошту.'); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value.trim())) { say('err', 'Перевірте адресу електронної пошти.'); return; }
      if (!f.consent.checked) { say('err', 'Потрібна згода з політикою конфіденційності.'); return; }
      var btn = $('button[type=submit]', f); btn.disabled = true;
      var val = function (name) { return f.elements[name] ? f.elements[name].value : ''; };
      var body = {
        name: val('name'), company: val('company'), email: val('email'), phone: val('phone'),
        segment: val('segment'), sites: val('sites'), message: val('message'),
        website: val('website'), source: f.getAttribute('data-source') || 'landing', lang: 'uk',
      };
      fetch('/api/public/pilot-request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.j && res.j.message || 'error');
          say('ok', 'Дякуємо, запит отримано. Відповімо протягом одного робочого дня.');
          f.reset();
        })
        .catch(function () {
          say('err', 'Не вдалося надіслати запит. Напишіть нам на ' + (cfg.contactEmail || 'електронну пошту, вказану внизу сторінки') + '.');
        })
        .then(function () { btn.disabled = false; });
    });
  }

  applyConfig(); nav(); form();
})();
