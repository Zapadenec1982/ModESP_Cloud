/* ModESP Cloud landing — plain JS, no build, no inline scripts or styles (CSP). */
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
  var fmt = function (n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' '); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  // ── Config-driven links: an empty value hides the element ──
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

  // ── One night of one cabinet: the story the timeline tells, as a chart ──
  // Deterministic demo data; the events match the #how timeline and the
  // journal rows in #haccp. Presentation comes from classes only (CSP).
  function storyChart() {
    var host = $('#story-chart'); if (!host) return;
    var W = 640, H = 300, L = 40, R = 14, T = 16, B = 30;
    var minutes = 8 * 60, step = 2, n = minutes / step;               // one night: 00:00–08:00
    var setpoint = -18, limit = -15, yMin = -24, yMax = -6;
    var doorOpen = 72, alarmAt = 74, techAt = 98, okAt = 125;      // 01:12, 01:14, 01:38, 02:05
    var defrosts = [300];                                             // 05:00 — a planned rise, not an alarm
    var seed = 11;
    var rnd = function () { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 - 0.5; };
    var pts = [];
    for (var i = 0; i < n; i++) {
      var m = i * step;
      var t = setpoint - 0.35 + 0.55 * Math.sin(m / 9) + rnd() * 0.3;
      defrosts.forEach(function (d) { var dt = m - d; if (dt >= 0 && dt < 40) t += 3.4 * Math.sin(dt / 40 * Math.PI); });
      if (m >= doorOpen && m < techAt) t += 8.6 * Math.min(1, (m - doorOpen) / 26);
      else if (m >= techAt && m < okAt + 30) { var k = (m - techAt) / (okAt + 30 - techAt); t += 8.6 * (1 - k) * Math.exp(-3.2 * k); }
      pts.push(t);
    }
    var x = function (m) { return L + (m / minutes) * (W - L - R); };
    var y = function (v) { return T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B); };
    var s = ['<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true" focusable="false">'];
    defrosts.forEach(function (d) {
      s.push('<rect class="band-defrost" x="' + x(d).toFixed(1) + '" y="' + T + '" width="' + (x(d + 40) - x(d)).toFixed(1) + '" height="' + (H - T - B) + '"/>');
    });
    s.push('<rect class="band-alarm" x="' + x(alarmAt).toFixed(1) + '" y="' + T + '" width="' + (x(okAt) - x(alarmAt)).toFixed(1) + '" height="' + (H - T - B) + '"/>');
    for (var g = yMin; g <= yMax; g += 6) {
      s.push('<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(g).toFixed(1) + '" y2="' + y(g).toFixed(1) + '"/>');
      s.push('<text class="axis-text" x="' + (L - 6) + '" y="' + (y(g) + 3.5).toFixed(1) + '" text-anchor="end">' + g + '°</text>');
    }
    for (var h = 0; h <= 8; h += 1) {
      s.push('<text class="axis-text" x="' + x(h * 60).toFixed(1) + '" y="' + (H - 9) + '" text-anchor="' + (h === 0 ? 'start' : h === 8 ? 'end' : 'middle') + '">0' + h + ':00</text>');
    }
    s.push('<line class="line-set" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(setpoint).toFixed(1) + '" y2="' + y(setpoint).toFixed(1) + '"/>');
    s.push('<line class="line-limit" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(limit).toFixed(1) + '" y2="' + y(limit).toFixed(1) + '"/>');
    var d = pts.map(function (v, i) { return (i ? 'L' : 'M') + x(i * step).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
    s.push('<path class="line-air" d="' + d + '"/>');
    var mark = function (m, cls, label, dx, dy, anchor) {
      var px = x(m), py = y(pts[Math.round(m / step)]);
      s.push('<circle class="marker ' + cls + '" cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="5"/>');
      s.push('<text class="marker-text" x="' + (px + dx).toFixed(1) + '" y="' + (py + dy).toFixed(1) + '" text-anchor="' + anchor + '">' + label + '</text>');
    };
    mark(doorOpen, 'marker-door', '01:12 двері', -10, 4, 'end');
    mark(alarmAt + 6, 'marker-alarm', '01:14 аварія → Telegram', -10, -6, 'end');
    mark(techAt, 'marker-tech', '01:38 технік', 12, -8, 'start');
    mark(okAt + 4, 'marker-ok', '02:05 −18 °C', 12, 16, 'start');
    s.push('<text class="marker-text" x="' + (x(defrosts[0] + 20)).toFixed(1) + '" y="' + (T + 12) + '" text-anchor="middle">05:00 відтайка</text>');
    s.push('</svg>');
    host.innerHTML = s.join('');
  }

  // ── Pricing from the catalogue (/api/public/plans) ──
  // Limits stay off this page on purpose: they live in the cabinet and in the offer.
  var FEATURE_LABELS = {
    geo: 'Точки і карта', energy: 'Енергія в гривнях', reports: 'HACCP PDF і планові звіти', maintenance: 'Рекомендації з обслуговування',
    weather: 'Погода на точках', routing: 'Планувальник об\'їзду', ota_rollout: 'OTA-ролаути', api: 'API-ключі й вебхуки',
    branding: 'Ваш бренд на сторінках і PDF', partner: 'Партнерський рахунок',
  };
  var CTA = {
    free: ['Зареєструватися', '/cloud/#/register', 'btn-ghost'],
    basic: ['Попросити пілот', '#pilot', 'btn-primary'],
    pro: ['Попросити пілот', '#pilot', 'btn-ghost'],
    partner: ['Партнерська програма', '/partners.html', 'btn-ghost'],
    enterprise: ['Обговорити', '#pilot', 'btn-ghost'],
  };
  function priceLine(p) {
    if (p.price_base_uah) return fmt(p.price_base_uah) + ' грн<small>/міс</small> + ' + fmt(p.price_controller_uah || 0) + ' грн<small>/контролер</small>';
    if (p.price_site_uah) return fmt(p.price_site_uah) + ' грн<small>/точка</small> + ' + fmt(p.price_controller_uah || 0) + ' грн<small>/контролер</small>';
    if (p.price_controller_uah === 0) return '0 грн';
    if (p.price_controller_uah) return fmt(p.price_controller_uah) + ' грн<small>/контролер/міс</small>';
    return 'за запитом';
  }
  function renderPlans(plans) {
    var host = $('#plans'); if (!host || !plans.length) return;
    host.innerHTML = plans.map(function (p) {
      var feats = (p.features || []).map(function (f) { return FEATURE_LABELS[f] || f; });
      var cta = CTA[p.plan] || ['Попросити пілот', '#pilot', 'btn-ghost'];
      var free = p.price_controller_uah === 0 && !p.price_site_uah && !p.price_base_uah;
      return '<article class="card plan' + (p.plan === 'basic' ? ' plan-featured' : '') + '">' +
        (p.tagline ? '<span class="tag">' + esc(p.tagline) + '</span>' : '') +
        '<h3>' + esc(p.name) + '</h3>' +
        '<div class="price">' + priceLine(p) + '</div>' +
        (p.price_note && !free ? '<div class="note">' + esc(p.price_note) + '</div>' : '') +
        (feats.length ? '<ul>' + feats.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' : '<div class="note">Панель, аварії, Telegram і push, CSV</div>') +
        '<a class="btn ' + cta[2] + '" href="' + cta[1] + '" data-plan="' + esc(p.plan) + '">' + cta[0] + '</a>' +
        '</article>';
    }).join('');
    $$('[data-plan]', host).forEach(function (a) {
      a.addEventListener('click', function () {
        var s = $('#pilot-form select[name=plan]');
        if (s && a.getAttribute('href') === '#pilot') s.value = a.getAttribute('data-plan');
      });
    });
  }
  function plans() {
    if (!window.fetch) return;
    fetch('/api/public/plans', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.data) renderPlans(j.data); })
      .catch(function () { /* the static cards stay */ });
  }

  // ── Pilot request form ──
  function form() {
    var f = $('#pilot-form'); if (!f) return;
    var msg = $('#pilot-msg');
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!f.name.value.trim() || !f.email.value.trim()) { msg.className = 'form-msg err'; msg.textContent = 'Потрібні ім\'я та e-mail.'; return; }
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

  // ── Scroll reveals: a class, so the motion (and its absence) lives in CSS ──
  function reveal() {
    var els = $$('.reveal');
    if (!('IntersectionObserver' in window)) { els.forEach(function (el) { el.classList.add('in'); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    els.forEach(function (el) { io.observe(el); });
    // Whatever happens to the observer, no section stays invisible: after a
    // few seconds everything not yet revealed is shown without the motion.
    setTimeout(function () { els.forEach(function (el) { el.classList.add('in'); io.disconnect(); }); }, 2500);
  }

  applyConfig(); storyChart(); plans(); form(); reveal();
})();
