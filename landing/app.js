/* ModESP Cloud landing — plain JS, no build, no inline scripts (CSP). */
(function () {
  'use strict';

  // Links from before the landing took "/" carried the app's hash routes
  // (#/dashboard, #/invite/…, #/public/site/…): hand them to the app.
  if (location.hash && location.hash.indexOf('#/') === 0) {
    location.replace('/cloud/' + location.hash);
    return;
  }

  var cfg = window.MODESP_LANDING || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var fmt = function (n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); };

  // ── Config-driven links ────────────────────────────────
  function applyConfig() {
    $$('[data-cfg]').forEach(function (el) {
      var key = el.getAttribute('data-cfg');
      var val = cfg[key];
      if (!val) { el.hidden = true; return; }
      if (el.tagName === 'A') el.href = key === 'contactEmail' ? 'mailto:' + val : val;
      if (el.hasAttribute('data-cfg-text')) el.textContent = val;
    });
    var y = $('[data-year]'); if (y) y.textContent = String(new Date().getFullYear());
  }

  // ── 30-day chart (demo data of one cabinet; deterministic) ──
  function chart() {
    var host = $('#chart'); if (!host) return;
    var W = 800, H = 260, L = 44, R = 12, T = 12, B = 28;
    var days = 30, per = 24, n = days * per;
    var seed = 7; var rnd = function () { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 - 0.5; };
    var setpoint = -18, pts = [], alarms = [], defrosts = [];
    for (var i = 0; i < n; i++) {
      var h = i % per, d = Math.floor(i / per);
      var t = setpoint + 0.9 * Math.sin((h - 9) / 24 * Math.PI * 2) + rnd() * 0.6;
      if (h % 6 === 3) { t += 3.5; defrosts.push(i); }          // defrost every 6 h
      if (d === 12 && h >= 14 && h <= 19) { t += (h - 13) * 2.2; if (h === 14) alarms.push([i, i + 5]); } // door left open
      if (d === 21 && h >= 4 && h <= 6) { t += (h - 3) * 1.4; if (h === 4) alarms.push([i, i + 2]); }     // compressor restart
      pts.push(t);
    }
    var yMin = -24, yMax = -4;
    var x = function (i) { return L + (i / (n - 1)) * (W - L - R); };
    var y = function (v) { return T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B); };
    var svg = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Температура однієї вітрини за 30 днів">'];
    alarms.forEach(function (a) { svg.push('<rect class="band-alarm" x="' + x(a[0]) + '" y="' + T + '" width="' + (x(a[1]) - x(a[0])) + '" height="' + (H - T - B) + '"/>'); });
    for (var g = yMin; g <= yMax; g += 4) {
      svg.push('<line class="axis" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(g) + '" y2="' + y(g) + '"/>');
      svg.push('<text class="axis-text" x="' + (L - 6) + '" y="' + (y(g) + 4) + '" text-anchor="end">' + g + '°</text>');
    }
    for (var dd = 0; dd <= days; dd += 5) {
      var xx = x(Math.min(dd * per, n - 1));
      svg.push('<text class="axis-text" x="' + xx + '" y="' + (H - 8) + '" text-anchor="middle">' + (dd === 0 ? '1' : dd) + ' д.</text>');
    }
    svg.push('<line class="line-set" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(setpoint) + '" y2="' + y(setpoint) + '" stroke-width="1.5"/>');
    var path = pts.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
    svg.push('<path class="line-air" d="' + path + '" fill="none" stroke-width="1.6"/>');
    svg.push('</svg>');
    host.innerHTML = svg.join('');
  }

  // ── Fine vs subscription calculator ─────────────────────
  function calc() {
    var form = $('#calc'); if (!form) return;
    var FINE = 259410; // штраф 2026 р. за відсутність HACCP для юрособи, грн
    var out = $('#calc-out');
    function update() {
      var ctrl = Math.max(1, parseInt(form.controllers.value, 10) || 1);
      var sites = Math.max(1, parseInt(form.sites.value, 10) || 1);
      var plan = form.plan.value;
      var monthly = plan === 'pro' ? sites * 250 + ctrl * (ctrl >= 500 ? 60 : ctrl >= 100 ? 80 : 100) : ctrl * 150;
      var years = FINE / (monthly * 12);
      out.innerHTML =
        '<strong>' + fmt(monthly) + ' грн / міс</strong>' +
        '<p>' + fmt(monthly * 12) + ' грн на рік за ' + ctrl + ' контролер' + (ctrl === 1 ? '' : ctrl < 5 ? 'и' : 'ів') +
        (plan === 'pro' ? ' на ' + sites + ' точк' + (sites === 1 ? 'у' : sites < 5 ? 'и' : 'ах') : '') + '.</p>' +
        '<p>Один штраф за відсутність HACCP (' + fmt(FINE) + ' грн) = <b>' + years.toFixed(1) + ' рок' + (years < 2 ? 'у' : years < 5 ? 'и' : 'ів') + '</b> підписки.</p>' +
        '<p class="muted small">Ціни без ПДВ. Зіпсований товар однієї вітрини за ніч зазвичай коштує більше за річну підписку на неї.</p>';
    }
    $$('input, select', form).forEach(function (el) { el.addEventListener('input', update); });
    form.addEventListener('submit', function (e) { e.preventDefault(); update(); });
    update();
  }

  // ── Pricing from the catalogue (/api/public/plans) ─────
  var FEATURE_LABELS = { geo: 'Точки і карта', energy: 'Енергомоніторинг', reports: 'HACCP PDF і планові звіти', weather: 'Погода на точках', routing: 'Планувальник об\'їзду', ota_rollout: 'OTA-ролаути', api: 'API-ключі', branding: 'Брендовані сторінки і PDF', partner: 'Партнерський рахунок' };
  function priceLine(p) {
    if (p.price_base_uah) return fmt(p.price_base_uah) + ' грн<small>/міс</small> + ' + fmt(p.price_controller_uah || 0) + ' грн<small>/контролер</small>';
    if (p.price_site_uah) return fmt(p.price_site_uah) + ' грн<small>/точка</small> + ' + fmt(p.price_controller_uah || 0) + ' грн<small>/контролер</small>';
    if (p.price_controller_uah === 0) return '0 грн';
    if (p.price_controller_uah) return fmt(p.price_controller_uah) + ' грн<small>/контролер/міс</small>';
    return 'за запитом';
  }
  function limit(v, one, many) { return v === null || v === undefined ? 'без обмежень' : v + ' ' + (v === 1 ? one : many); }
  function renderPlans(plans) {
    var host = $('#plans'); if (!host || !plans.length) return;
    host.innerHTML = plans.map(function (p) {
      var feats = (p.features || []).map(function (f) { return FEATURE_LABELS[f] || f; });
      return '<article class="card plan' + (p.plan === 'basic' ? ' plan-featured' : '') + '">' +
        '<span class="tag">' + esc(p.tagline || '') + '</span>' +
        '<h3>' + esc(p.name) + '</h3>' +
        '<div class="price">' + priceLine(p) + '</div>' +
        '<div class="note">' + esc(p.price_note || '') + '</div>' +
        '<ul><li>' + limit(p.max_devices, 'контролер', 'контролерів') + '</li>' +
        '<li>' + limit(p.max_sites, 'точка', 'точок') + ', ' + limit(p.max_users, 'користувач', 'користувачів') + '</li>' +
        '<li>Історія: ' + p.retention_days + ' дн. первинних даних, 3 роки погодинного архіву</li>' +
        (feats.length ? '<li>' + feats.map(esc).join(', ') + '</li>' : '<li>Панель, Telegram і push, CSV</li>') +
        '</ul>' +
        '<a class="btn ' + (p.plan === 'basic' ? 'btn-primary' : 'btn-ghost') + '" href="#pilot" data-plan="' + esc(p.plan) + '">' + (p.plan === 'free' ? 'Почати безкоштовно' : p.plan === 'enterprise' ? 'Обговорити' : 'Попросити пілот') + '</a>' +
        '</article>';
    }).join('');
    $$('[data-plan]', host).forEach(function (a) { a.addEventListener('click', function () { var s = $('#pilot-form select[name=plan]'); if (s) s.value = a.getAttribute('data-plan'); }); });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function plans() {
    if (!window.fetch) return;
    fetch('/api/public/plans', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.data) renderPlans(j.data); })
      .catch(function () { /* static cards stay */ });
  }

  // ── Pilot request form ─────────────────────────────────
  function form() {
    var f = $('#pilot-form'); if (!f) return;
    var msg = $('#pilot-msg');
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!f.consent.checked) { msg.className = 'form-msg err'; msg.textContent = 'Потрібна згода з політикою конфіденційності.'; return; }
      var btn = $('button[type=submit]', f); btn.disabled = true;
      var body = {
        name: f.name.value, company: f.company.value, email: f.email.value, phone: f.phone.value,
        segment: f.segment.value, sites: f.sites.value, message: (f.plan.value ? '[план: ' + f.plan.value + '] ' : '') + f.message.value,
        website: f.website.value, source: f.getAttribute('data-source') || 'landing', lang: 'uk',
      };
      fetch('/api/public/pilot-request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.j && res.j.message || 'error');
          msg.className = 'form-msg ok';
          msg.textContent = 'Дякуємо! Ми відповімо протягом одного робочого дня.';
          f.reset();
        })
        .catch(function (err) {
          msg.className = 'form-msg err';
          msg.textContent = 'Не вдалося надіслати запит (' + err.message + '). Напишіть нам на ' + (cfg.contactEmail || 'пошту в підвалі сторінки') + '.';
        })
        .then(function () { btn.disabled = false; });
    });
  }

  applyConfig(); chart(); calc(); plans(); form();
})();
