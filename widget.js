/* Minimal CSV parser (handles simple quoted values) */
function parseCSV(text) {
  const rows = [];
  let cur = [], val = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i+1];
    if (inQuotes) {
      if (c === '"' && n === '"') { val += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { val += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { cur.push(val); val = ''; }
      else if (c === '\n') { cur.push(val); rows.push(cur); cur = []; val = ''; }
      else if (c === '\r') { /* ignore */ }
      else { val += c; }
    }
  }
  if (val.length || cur.length) { cur.push(val); rows.push(cur); }
  return rows;
}

/* Build index and helpers from rows */
function buildIndex(rows) {
  const [header, ...data] = rows;
  const idx = {};
  header.forEach((h, i) => idx[h.trim()] = i);

  const pages = data.map(r => ({
    page_id: r[idx['page_id']],
    title: r[idx['title']],
    url: (r[idx['url']] || '').trim(),
    breadcrumb_html: r[idx['breadcrumb_html']] || ''
  })).filter(p => p.url);

  // Normalize URLs to start with '/'
  pages.forEach(p => {
    if (!p.url.startsWith('/')) p.url = '/' + p.url;
  });

  const byUrl = new Map(pages.map(p => [p.url, p]));
  const byFirst = new Map();
  const childrenOf = new Map();

  function firstLevel(url) {
    const segs = url.split('/').filter(Boolean);
    return segs.length ? segs[0].toLowerCase() : 'india';
  }
  function parentPath(url) {
    const segs = url.split('/').filter(Boolean);
    if (!segs.length) return '/';
    const parent = '/' + segs.slice(0, segs.length - 1).join('/');
    return parent || '/';
  }

  for (const p of pages) {
    const fl = firstLevel(p.url);
    if (!byFirst.has(fl)) byFirst.set(fl, []);
    byFirst.get(fl).push(p);

    const parent = parentPath(p.url);
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(p);
  }

  // Compute representative entry for each first level (shortest URL wins)
  const topRep = new Map();
  for (const [fl, arr] of byFirst.entries()) {
    const rep = arr.reduce((a, b) => (a.url.length <= b.url.length ? a : b));
    topRep.set(fl, rep);
  }

  return { pages, byUrl, byFirst, childrenOf, topRep };
}

/* Render helpers */
function makeChip(href, label) {
  const a = document.createElement('a');
  a.className = 'gsi-cn-chip';
  a.href = href;
  a.textContent = label;
  a.rel = 'noopener';
  return a;
}
function makeLink(href, label) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = label;
  a.rel = 'noopener';
  return a;
}

/* Try to detect the current page path
   1) document.referrer (most reliable when embedded as URL in Google Sites)
   2) ?current=/path passed on the widget URL (fallback)
   3) default to '/india'
*/
function detectCurrentPath() {
  try {
    if (document.referrer) {
      const ref = new URL(document.referrer);
      if (ref.pathname && ref.pathname !== '/') return ref.pathname;
    }
  } catch {}
  const qp = new URLSearchParams(location.search).get('current');
  if (qp && qp.startsWith('/')) return qp;
  return '/india';
}

/* Build breadcrumb chips from the pre-linked breadcrumb_html (anchors/spans) */
function renderBreadcrumb(container, breadcrumbHTML) {
  // Extract anchors and spans, convert to chips
  const temp = document.createElement('div');
  temp.innerHTML = breadcrumbHTML;
  const parts = temp.querySelectorAll('a, span');
  parts.forEach(el => {
    if (el.tagName === 'A') {
      const chip = makeChip(el.href, el.textContent.trim());
      container.appendChild(chip);
    } else {
      const chip = document.createElement('span');
      chip.className = 'gsi-cn-chip';
      chip.textContent = el.textContent.trim();
      container.appendChild(chip);
    }
  });
}

/* Render related siblings (same parent) with show more */
function renderRelated(listEl, moreBtn, siblings, currentUrl, limit = 6) {
  const others = siblings.filter(s => s.url !== currentUrl);
  if (!others.length) { listEl.innerHTML = '<li><span>No related pages</span></li>'; return; }
  const top = others.slice(0, limit);
  top.forEach(s => {
    const li = document.createElement('li');
    li.appendChild(makeLink(s.url, s.title));
    listEl.appendChild(li);
  });
  if (others.length > limit) {
    moreBtn.hidden = false;
    moreBtn.addEventListener('click', () => {
      others.slice(limit).forEach(s => {
        const li = document.createElement('li');
        li.appendChild(makeLink(s.url, s.title));
        listEl.appendChild(li);
      });
      moreBtn.hidden = true;
    });
  }
}

/* Render top-level quick links (first-level reps), ordered for your site */
function renderTop(topEl, topRep) {
  const order = ['info','legacy','heritage','explore','travel','highlights','india-store','india'];
  const icons = {
    info: 'ℹ️', legacy: '🏛️', heritage: '🪔', explore: '🧭',
    travel: '✈️', highlights: '⭐', 'india-store': '🛍️', india: '🏠'
  };
  order.forEach(fl => {
    const rep = topRep.get(fl);
    if (!rep) return;
    const a = document.createElement('a');
    a.href = rep.url;
    a.innerHTML = `<div class="gsi-cn-top-icon">${icons[fl] || '📄'}</div><div>${fl.replace('-', ' ')}</div>`;
    a.setAttribute('aria-label', `Go to ${fl}`);
    topEl.appendChild(a);
  });
}

/* Initialize */
(async function init() {
  const currentPath = detectCurrentPath();
  const qs = new URLSearchParams(location.search);
  // CSV URL can be specified: ?data=<absolute-or-relative-url>
  const csvUrl = qs.get('data') || 'india_sitemap_table__with_page_id_and_linked_breadcrumbs.csv';

  let csv;
  try {
    const resp = await fetch(csvUrl, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`Failed to load CSV: ${resp.status}`);
    csv = await resp.text();
  } catch (e) {
    console.warn('[ContextNav] CSV load error:', e);
    // Fallback: top sections only with minimal defaults
    document.getElementById('gsi-cn-breadcrumbs').innerHTML =
      '<span class="gsi-cn-chip">Navigation</span>';
    const top = document.getElementById('gsi-cn-top');
    ['/', '/info', '/legacy', '/heritage', '/explore', '/travel', '/highlights'].forEach((u, i) => {
      const a = document.createElement('a'); a.href = u; a.textContent = ['Home','Info','Legacy','Heritage','Explore','Travel','Highlights'][i];
      top.appendChild(a);
    });
    attachToggle();
    return;
  }

  const rows = parseCSV(csv).map(cells => cells.map(c => c.trim()));
  if (!rows.length) return;
  const { pages, byUrl, childrenOf, topRep } = buildIndex(rows);

  // Find current page; if not found, try to strip trailing slash
  let cur = byUrl.get(currentPath);
  if (!cur && currentPath.endsWith('/')) cur = byUrl.get(currentPath.slice(0, -1));

  // Render breadcrumbs
  const bcEl = document.getElementById('gsi-cn-breadcrumbs');
  if (cur && cur.breadcrumb_html) {
    renderBreadcrumb(bcEl, cur.breadcrumb_html);
  } else {
    // Derive breadcrumb from URL segments as fallback
    const segs = currentPath.split('/').filter(Boolean);
    let accum = '';
    segs.forEach((s, i) => {
      accum += '/' + s;
      const p = byUrl.get(accum);
      if (p) bcEl.appendChild(makeChip(p.url, p.title || s));
      else {
        const span = document.createElement('span');
        span.className = 'gsi-cn-chip';
        span.textContent = s.replace(/-/g, ' ');
        bcEl.appendChild(span);
      }
    });
    if (!segs.length) bcEl.appendChild(makeChip('/india', 'India'));
  }

  // Render related (siblings under same parent)
  const parent = (() => {
    const segs = (cur?.url || currentPath).split('/').filter(Boolean);
    return segs.length ? '/' + segs.slice(0, segs.length - 1).join('/') : '/';
  })();
  const siblings = childrenOf.get(parent) || [];
  renderRelated(
    document.getElementById('gsi-cn-related'),
    document.getElementById('gsi-cn-more'),
    siblings, (cur?.url || currentPath)
  );

  // Render top sections
  renderTop(document.getElementById('gsi-cn-top'), topRep);

  attachToggle();
})();

function attachToggle() {
  const root = document.querySelector('.gsi-context-nav');
  const btn = document.getElementById('gsi-cn-toggle');
  const panel = document.getElementById('gsi-cn-panel');
  function setOpen(isOpen) {
    root.classList.toggle('open', isOpen);
    btn.setAttribute('aria-expanded', String(isOpen));
  }
  btn.addEventListener('click', () => setOpen(!root.classList.contains('open')));

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });
}
