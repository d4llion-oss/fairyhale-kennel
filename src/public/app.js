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

// Medical conditions: autocomplete + summary dialog
(function () {
  'use strict';
  var form = document.querySelector('[data-condition-form]');
  var dialog = document.getElementById('cond-dialog');

  if (form) {
    var input = form.querySelector('[data-condition-input]');
    var wiki = form.querySelector('input[name=wiki]');
    var list = form.querySelector('.ac-list');
    var items = [], active = -1, timer = null, lastQ = '';

    function close() { list.hidden = true; list.innerHTML = ''; items = []; active = -1; input.setAttribute('aria-expanded', 'false'); }
    function render() {
      list.innerHTML = '';
      items.forEach(function (it, i) {
        var li = document.createElement('li');
        li.setAttribute('role', 'option'); li.setAttribute('aria-selected', i === active ? 'true' : 'false');
        var name = document.createElement('span'); name.textContent = it.name;
        var src = document.createElement('span'); src.className = 'src'; src.textContent = it.source === 'wikipedia' ? 'Wikipedia' : '';
        li.appendChild(name); li.appendChild(src);
        li.addEventListener('mousedown', function (ev) { ev.preventDefault(); choose(i); });
        list.appendChild(li);
      });
      list.hidden = !items.length; input.setAttribute('aria-expanded', items.length ? 'true' : 'false');
    }
    function choose(i) { var it = items[i]; if (!it) return; input.value = it.name; wiki.value = it.wiki || ''; close(); form.querySelector('input[name=notes]').focus(); }
    function fetchSuggestions() {
      var q = input.value.trim();
      if (q === lastQ) return; lastQ = q; wiki.value = '';
      if (q.length < 2) return close();
      fetch('/conditions/suggest?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (data) { if (input.value.trim() !== q) return; items = data; active = -1; render(); })
        .catch(close);
    }
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(fetchSuggestions, 180); });
    input.addEventListener('keydown', function (ev) {
      if (list.hidden) return;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); active = (active + 1) % items.length; render(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
      else if (ev.key === 'Enter' && active >= 0) { ev.preventDefault(); choose(active); }
      else if (ev.key === 'Tab' && active >= 0) { choose(active); }
      else if (ev.key === 'Escape') { close(); }
    });
    input.addEventListener('blur', function () { setTimeout(close, 120); });
  }

  if (dialog && typeof dialog.showModal === 'function') {
    var title = document.getElementById('cond-title'), body = document.getElementById('cond-body'), foot = document.getElementById('cond-foot');
    document.querySelectorAll('.cond-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        title.textContent = chip.dataset.condition;
        body.innerHTML = '<p class="muted">Looking up…</p>'; foot.textContent = '';
        dialog.showModal();
        var url = '/conditions/summary?name=' + encodeURIComponent(chip.dataset.condition) + (chip.dataset.wiki ? '&wiki=' + encodeURIComponent(chip.dataset.wiki) : '');
        fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
          body.innerHTML = '';
          var p = document.createElement('p');
          if (d.extract) { p.textContent = d.extract; }
          else if (d.kind === 'disambiguation') { p.textContent = 'That name matches several topics. Open the link below to pick the right one, or re-add the condition with a more specific name.'; }
          else if (d.kind === 'missing') { p.textContent = 'No reference article was found for this condition name.'; }
          else { p.textContent = 'The reference service could not be reached right now. Try again in a moment.'; }
          body.appendChild(p);
          if (d.title && d.title !== chip.dataset.condition) { var s = document.createElement('p'); s.className = 'muted small'; s.textContent = 'Article: ' + d.title; body.appendChild(s); }
          foot.innerHTML = '';
          if (d.url) { var a = document.createElement('a'); a.href = d.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Read more on Wikipedia ↗'; foot.appendChild(a); foot.appendChild(document.createTextNode(' · ')); }
          foot.appendChild(document.createTextNode('General reference only — not veterinary advice.'));
        }).catch(function () { body.innerHTML = '<p>The reference service could not be reached right now.</p>'; });
      });
    });
    dialog.addEventListener('click', function (ev) { if (ev.target === dialog) dialog.close(); });
  }
})();
