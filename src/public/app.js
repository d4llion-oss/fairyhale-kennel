// FairyHale Kennel — progressive enhancement. Everything here is optional:
// every form works without JavaScript. Kept in a static file because the
// Content-Security-Policy disallows inline scripts and on* attributes.
(function () {
  'use strict';

  // Confirm dialogs: <form data-confirm="Are you sure?">
  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (ev) {
      if (!window.confirm(f.dataset.confirm)) ev.preventDefault();
    });
  });

  // Auto-submit controls: <select data-autosubmit> or <form data-autosubmit> (submits on any change)
  document.querySelectorAll('[data-autosubmit]').forEach(function (el) {
    var form = el.tagName === 'FORM' ? el : el.form;
    if (!form) return;
    el.addEventListener('change', function () { form.requestSubmit ? form.requestSubmit() : form.submit(); });
  });

  // Duration quick-pick buttons
  document.querySelectorAll('[data-set-duration]').forEach(function (b) {
    b.addEventListener('click', function () {
      var input = document.getElementById('duration_minutes');
      if (input) { input.value = b.dataset.setDuration; input.dispatchEvent(new Event('change', { bubbles: true })); }
    });
  });

  // Activity form: single vs bulk mode
  var form = document.getElementById('activity-form');
  if (form) {
    var single = document.getElementById('single-picker');
    var bulk = document.getElementById('bulk-picker');
    var select = document.getElementById('animal_id');
    var count = document.getElementById('picked-count');
    var btn = document.getElementById('submit-btn');
    var boxes = Array.prototype.slice.call(bulk.querySelectorAll('input[type=checkbox]'));
    function mode() { var m = form.querySelector('input[name=mode]:checked'); return m ? m.value : 'single'; }
    function refresh() {
      var b = mode() === 'bulk';
      single.hidden = b; bulk.hidden = !b; select.required = !b;
      var n = boxes.filter(function (c) { return c.checked; }).length;
      count.textContent = n;
      btn.textContent = b ? (n ? 'Save ' + n + ' entr' + (n === 1 ? 'y' : 'ies') : 'Save entries') : 'Save entry';
    }
    form.addEventListener('change', refresh);
    bulk.querySelectorAll('[data-pick]').forEach(function (b) {
      b.addEventListener('click', function () { boxes.forEach(function (c) { c.checked = b.dataset.pick === 'all'; }); refresh(); });
    });
    bulk.querySelectorAll('[data-pick-type]').forEach(function (b) {
      b.addEventListener('click', function () { boxes.forEach(function (c) { if (c.dataset.type === b.dataset.pickType) c.checked = true; }); refresh(); });
    });
    refresh();
  }

  // Dashboard type filter: close the dropdown when clicking outside
  document.querySelectorAll('details.dropdown').forEach(function (d) {
    document.addEventListener('click', function (ev) { if (d.open && !d.contains(ev.target)) d.open = false; });
  });
})();

// Photo gallery: prev/next/thumbnail navigation + arrow keys
(function () {
  'use strict';
  document.querySelectorAll('[data-gallery]').forEach(function (g) {
    var slides = Array.prototype.slice.call(g.querySelectorAll('[data-slide]'));
    var thumbs = Array.prototype.slice.call(g.querySelectorAll('[data-thumb]'));
    if (slides.length < 2) return;
    var i = 0;
    function show(n) {
      i = (n + slides.length) % slides.length;
      slides.forEach(function (s, k) { s.hidden = k !== i; });
      thumbs.forEach(function (t, k) { t.classList.toggle('active', k === i); });
    }
    g.querySelectorAll('[data-gallery-prev]').forEach(function (b) { b.addEventListener('click', function () { show(i - 1); }); });
    g.querySelectorAll('[data-gallery-next]').forEach(function (b) { b.addEventListener('click', function () { show(i + 1); }); });
    g.querySelectorAll('[data-gallery-go]').forEach(function (b) { b.addEventListener('click', function () { show(parseInt(b.dataset.galleryGo, 10)); }); });
    document.addEventListener('keydown', function (ev) {
      if (ev.target.matches('input, textarea, select')) return;
      if (ev.key === 'ArrowLeft') show(i - 1);
      if (ev.key === 'ArrowRight') show(i + 1);
    });
    // Swipe on touch devices
    var x0 = null;
    g.addEventListener('touchstart', function (ev) { x0 = ev.touches[0].clientX; }, { passive: true });
    g.addEventListener('touchend', function (ev) {
      if (x0 == null) return;
      var dx = ev.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 40) show(dx < 0 ? i + 1 : i - 1);
    }, { passive: true });
  });
})();
