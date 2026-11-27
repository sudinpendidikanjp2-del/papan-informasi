import './icons.js';
import './common.js';
import Sortable from 'sortablejs';
import { createDropzone, formatBytes } from './dropzone.js';
import { uploadFile, watchConversion, formatEta, speedText } from './upload.js';
import { parseYoutubeId, thumbnailUrl } from './youtube.js';

(function () {
  const P = window.Papan;
  const I = window.Icons;
  const $ = (id) => document.getElementById(id);
  const esc = P.esc;
  const PER_PAGE = 8;

  const PAGES = {
    dashboard: 'Dasbor', content: 'Konten', screens: 'Layar', queue: 'Kategori & meja',
    users: 'Pegawai', report: 'Laporan', settings: 'Pengaturan',
  };
  const TYPE = { text: ['Teks', 'list'], image: ['Gambar', 'image'], video: ['Video', 'play'], pdf: ['PDF', 'file'], youtube: ['YouTube', 'youtube'] };

  let me = null;
  let summary = null;
  let contents = [];
  let screens = [];
  let categories = [];
  let counters = [];
  let users = [];
  let page = 'dashboard';

  // ---------- Util ----------

  function hydrateIcons(root) {
    (root || document).querySelectorAll('[data-ic]').forEach((e) => {
      if (!e.dataset.done) {
        e.insertAdjacentHTML('afterbegin', I.svg(e.dataset.ic));
        e.dataset.done = '1';
      }
    });
  }

  const names = (ids, list) => ids.map((id) => (list.find((x) => x.id === id) || {}).name).filter(Boolean);
  const checkedIds = (box) => [...box.querySelectorAll('input:checked')].map((i) => Number(i.value));

  function checkboxes(box, items, selected, labelFn) {
    box.innerHTML = items.length
      ? items.map((it) => '<label class="check"><input type="checkbox" value="' + it.id + '"' + (selected.includes(it.id) ? ' checked' : '') + '> ' + labelFn(it) + '</label>').join('')
      : '<span class="hint">Belum ada data</span>';
  }

  // Semua panggilan lewat sini: 401 mengembalikan ke form login, error lain jadi toast.
  async function call(path, opts) {
    try {
      return await P.api(path, opts);
    } catch (e) {
      if (e.status === 401) showLogin('Sesi berakhir. Silakan masuk lagi.');
      else P.toast(e.message);
      throw e;
    }
  }

  // Pagination sisi klien: "Menampilkan X dari N" + tombol halaman.
  function renderPager(box, total, cur, per, onPage, noun) {
    const pages = Math.max(1, Math.ceil(total / per));
    if (!total) { box.innerHTML = ''; return; }
    const from = (cur - 1) * per + 1;
    const to = Math.min(total, cur * per);
    const nums = [];
    for (let p = 1; p <= pages; p += 1) {
      if (p === 1 || p === pages || Math.abs(p - cur) <= 1) nums.push(p);
      else if (nums[nums.length - 1] !== '…') nums.push('…');
    }
    box.innerHTML =
      '<span>Menampilkan <b>' + from + '-' + to + '</b> dari ' + total + ' ' + noun + '</span>' +
      '<div class="pages">' +
      '<button data-p="' + (cur - 1) + '"' + (cur <= 1 ? ' disabled' : '') + ' aria-label="Sebelumnya">' + I.svg('left') + '</button>' +
      nums.map((n) => n === '…' ? '<button disabled>…</button>' : '<button data-p="' + n + '"' + (n === cur ? ' class="on" aria-current="page"' : '') + '>' + n + '</button>').join('') +
      '<button data-p="' + (cur + 1) + '"' + (cur >= pages ? ' disabled' : '') + ' aria-label="Berikutnya">' + I.svg('right') + '</button>' +
      '</div>';
    box.onclick = (e) => {
      const b = e.target.closest('button[data-p]');
      if (b && !b.disabled) onPage(Number(b.dataset.p));
    };
  }

  const clampPage = (p, total, per) => Math.min(Math.max(1, p), Math.max(1, Math.ceil(total / per)));

  // ---------- Laci formulir ----------

  function openDrawer(formId, title) {
    // Pakai getAttribute: form.id mengembalikan input bernama "id" di dalam form, bukan id form-nya.
    for (const f of document.querySelectorAll('#drawer form')) f.classList.toggle('hidden', f.getAttribute('id') !== formId);
    $('drawerTitle').textContent = title;
    $('drawer').classList.add('open');
    $('drawer').setAttribute('aria-hidden', 'false');
    $('drawerScrim').classList.add('open');
    setTimeout(() => {
      const first = $(formId).querySelector('input:not([type=hidden]):not([type=file]):not([type=checkbox]), select, textarea');
      if (first) first.focus();
    }, 220);
  }

  function closeDrawer() {
    $('drawer').classList.remove('open');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('drawerScrim').classList.remove('open');
  }
  $('drawerClose').addEventListener('click', closeDrawer);
  $('drawerScrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeDrawer));

  // ---------- Sesi & navigasi ----------

  function showLogin(msg) {
    $('shell').classList.add('hidden');
    $('loginView').classList.remove('hidden');
    $('loginErr').textContent = msg || '';
  }

  async function enter() {
    try {
      me = await P.api('/api/auth/me');
    } catch {
      return showLogin();
    }
    if (me.role !== 'admin') {
      await P.api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
      return showLogin('Akun ini bukan admin. Gunakan halaman Panel meja.');
    }
    $('meName').textContent = me.name;
    $('meUser').textContent = '@' + me.username;
    $('meAv').textContent = I.initials(me.name);
    $('loginView').classList.add('hidden');
    $('shell').classList.remove('hidden');
    // Pilih halaman lebih dulu agar jejak halaman dan menu langsung benar selagi data dimuat.
    go(PAGES[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard');
    await loadAll();
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginErr').textContent = '';
    try {
      await P.api('/api/auth/login', { method: 'POST', body: { username: $('u').value, password: $('p').value } });
      $('p').value = '';
      await enter();
    } catch (err) {
      $('loginErr').textContent = err.message;
    }
  });

  $('logout').addEventListener('click', async () => {
    await P.api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    showLogin();
  });

  function go(name) {
    page = PAGES[name] ? name : 'dashboard';
    if (location.hash.slice(1) !== page) history.replaceState(null, '', '#' + page);
    document.querySelectorAll('.page').forEach((s) => s.classList.toggle('on', s.id === 'page-' + page));
    document.querySelectorAll('.nav-item[data-page]').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
    $('crumb').textContent = PAGES[page];
    // Di halaman Dasbor tidak perlu jejak "Dasbor / Dasbor".
    $('crumbRoot').classList.toggle('hidden', page === 'dashboard');
    $('crumbSep').classList.toggle('hidden', page === 'dashboard');
    $('shell').classList.remove('open');
    closeDrawer();
    if (page === 'dashboard') loadSummary().catch(() => {});
    if (page === 'report') loadReport().catch(() => {});
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.nav-item[data-page]').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
  window.addEventListener('hashchange', () => { if (PAGES[location.hash.slice(1)] && !$('shell').classList.contains('hidden')) go(location.hash.slice(1)); });
  $('menuBtn').addEventListener('click', () => $('shell').classList.toggle('open'));
  $('scrim').addEventListener('click', () => $('shell').classList.remove('open'));

  async function loadAll() {
    // Urutan penting: layar dan meja dipakai oleh form konten dan pegawai.
    await Promise.all([loadQueue(), loadSettings()]);
    await loadScreens();
    await Promise.all([loadContents(), loadUsers(), loadSummary()]);
  }

  // ---------- Dasbor ----------

  async function loadSummary() {
    summary = await call('/api/admin/summary');
    const s = summary;
    $('ffBanner').classList.toggle('hidden', s.ffmpeg);
    const kpi = (title, icon, val, small, cls) =>
      '<div class="kpi"><div class="top"><span>' + title + '</span>' + I.svg(icon) + '</div>' +
      '<div class="val num">' + val + (small ? '<small class="' + (cls || '') + '">' + small + '</small>' : '') + '</div></div>';
    $('kpis').innerHTML =
      kpi('Konten aktif', 'image', s.contentsActive, 'dari ' + s.contentsTotal) +
      kpi('Layar terdaftar', 'monitor', s.screens, s.screens ? '' : 'alamat / saja') +
      kpi('Pegawai aktif', 'users', s.staffActive, s.onlineCounters + ' dari ' + s.countersTotal + ' meja online', s.onlineCounters ? 'up' : '') +
      kpi('Antrian menunggu', 'ticket', s.waitingToday, '+' + s.doneToday + ' selesai', 'up');

    $('dashScreens').innerHTML = (screens.length
      ? screens.map((sc) =>
          '<div class="it"><div class="who"><span class="avatar sq">' + I.svg('monitor') + '</span><div><div class="n">' + esc(sc.name) + '</div>' +
          '<div class="s">' + (sc.categoryIds.length ? esc(names(sc.categoryIds, categories).join(', ')) : 'Semua kategori') + '</div></div></div>' +
          '<a class="btn btn-ghost btn-sm linkbtn" target="_blank" rel="noopener" href="/layar/' + encodeURIComponent(sc.slug) + '">Buka ' + I.svg('link') + '</a></div>').join('')
      : '<div class="empty">Belum ada layar terdaftar. Alamat <b>/</b> menampilkan semua antrian.</div>');

    const pct = s.ticketsToday ? Math.round((s.doneToday / s.ticketsToday) * 100) : 0;
    $('dashQueue').innerHTML =
      '<div class="it"><span>Nomor dibuat hari ini</span><b class="num">' + s.ticketsToday + '</b></div>' +
      '<div class="it"><span>Sedang menunggu</span><b class="num">' + s.waitingToday + '</b></div>' +
      '<div class="it"><span>Selesai dilayani</span><b class="num">' + s.doneToday + '</b></div>' +
      '<div class="progress-line" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100"><i style="width:' + pct + '%"></i></div>' +
      '<div class="hint" style="margin-top:6px">' + pct + '% selesai</div>';
  }

  // ---------- Konten ----------

  let cTab = 'all';
  let cSearch = '';
  let cScreen = '';
  let cPage = 1;
  const selected = new Set();

  async function loadContents() {
    contents = await call('/api/admin/content');
    for (const id of [...selected]) if (!contents.some((c) => c.id === id)) selected.delete(id);
    renderContent();
    const active = contents.filter((c) => c.active).length;
    const nb = $('navContentCnt');
    nb.textContent = active;
    nb.classList.toggle('hidden', !active);
  }

  function filteredContents() {
    const q = cSearch.trim().toLowerCase();
    return contents.filter((c) => {
      if (cTab === 'screensaver' ? !c.screensaver : (cTab !== 'all' && c.type !== cTab)) return false;
      if (cScreen === 'shared' && c.screens.length) return false;
      if (cScreen && cScreen !== 'shared' && !c.screens.includes(Number(cScreen))) return false;
      return !q || [c.title, c.file, c.body].some((t) => String(t || '').toLowerCase().includes(q));
    });
  }

  function renderContent() {
    const tabs = [
      ['all', 'Semua', contents.length],
      ['text', 'Teks', contents.filter((c) => c.type === 'text').length],
      ['image', 'Gambar', contents.filter((c) => c.type === 'image').length],
      ['video', 'Video', contents.filter((c) => c.type === 'video').length],
      ['pdf', 'PDF', contents.filter((c) => c.type === 'pdf').length],
      ['youtube', 'YouTube', contents.filter((c) => c.type === 'youtube').length],
      ['screensaver', 'Screensaver', contents.filter((c) => c.screensaver).length],
    ];
    $('contentTabs').innerHTML = tabs.map(([k, l, n]) =>
      '<button role="tab" aria-selected="' + (k === cTab) + '" class="' + (k === cTab ? 'on' : '') + '" data-tab="' + k + '">' + l + ' <span class="n">' + n + '</span></button>').join('');
    $('contentSub').textContent = 'Tayangan (' + contents.length + ')';

    const sel = $('contentScreenFilter');
    const keep = cScreen;
    sel.innerHTML = '<option value="">Semua layar</option><option value="shared">Konten bersama</option>' +
      screens.map((s) => '<option value="' + s.id + '">' + esc(s.name) + '</option>').join('');
    sel.value = keep;

    const list = filteredContents();
    // Urutan tayang diubah dengan seret-lepas hanya pada tampilan penuh (tab Semua, tanpa pencarian atau filter),
    // supaya urutan yang disimpan selalu urutan seluruh daftar. Pada mode itu semua baris ditampilkan tanpa halaman.
    const canOrder = cTab === 'all' && !cSearch.trim() && !cScreen && contents.length > 1;
    if (canOrder) cPage = 1;
    else cPage = clampPage(cPage, list.length, PER_PAGE);
    const rows = canOrder ? list : list.slice((cPage - 1) * PER_PAGE, cPage * PER_PAGE);
    $('orderHint').innerHTML = canOrder
      ? I.svg('grip') + ' Seret ikon di kiri baris (atau tekan panah atas/bawah saat ikon difokuskan) untuk mengubah urutan tayang.'
      : (contents.length > 1 ? 'Urutan hanya bisa diubah pada tab <b>Semua</b> tanpa pencarian atau filter.' : '');

    $('contentRows').innerHTML = rows.length
      ? rows.map((c) => {
          const [tl, ic] = TYPE[c.type];
          const scr = c.screens.length
            ? c.screens.map((id) => '<span class="pill">' + esc((screens.find((s) => s.id === id) || {}).name || '?') + '</span>').join('')
            : '<span class="muted">Semua layar</span>';
          const dur = (c.type === 'video' || c.type === 'youtube') && c.duration === 0 ? 'Sampai selesai'
            : c.type === 'youtube' ? 'maks. ' + c.duration + ' dtk'
            : c.type === 'pdf' ? c.duration + ' dtk / hal.' : c.duration + ' dtk';
          const title = c.title || (c.type === 'text' ? '(tanpa judul)' : c.type === 'youtube' ? c.url : c.file);
          return '<tr data-id="' + c.id + '" class="' + (selected.has(c.id) ? 'sel' : '') + '">' +
            '<td class="grip-col">' + (canOrder ? '<span class="grip" tabindex="0" role="button" aria-label="Geser untuk mengubah urutan: ' + esc(title) + '">' + I.svg('grip') + '</span>' : '') + '</td>' +
            '<td class="chk"><input type="checkbox" data-sel="' + c.id + '"' + (selected.has(c.id) ? ' checked' : '') + ' aria-label="Pilih ' + esc(title) + '"></td>' +
            '<td><div class="who"><span class="avatar sq">' + I.svg(ic) + '</span><div style="min-width:0"><div class="n">' + esc(title) + '</div><div class="s">' + tl + '' + '</div></div></div></td>' +
            '<td><div class="pills">' + scr + '</div></td>' +
            '<td>' + dur + '</td>' +
            '<td><div class="pills"><span class="pill ' + (c.active ? 'ok' : 'off') + '"><span class="dot"></span>' + (c.active ? 'Aktif' : 'Nonaktif') + '</span>' +
            (c.screensaver ? '<span class="pill hi">Screensaver</span>' : '') + '</div></td>' +
            '<td><div class="acts"><button class="btn btn-ghost btn-sm btn-icon" data-edit="' + c.id + '" aria-label="Ubah">' + I.svg('edit') + '</button>' +
            '<button class="btn btn-danger btn-sm btn-icon" data-del="' + c.id + '" aria-label="Hapus">' + I.svg('trash') + '</button></div></td></tr>';
        }).join('')
      : '<tr><td colspan="7" class="empty">' + (contents.length ? 'Tidak ada konten yang cocok dengan filter.' : 'Belum ada konten. Klik "Tambah konten".') + '</td></tr>';

    const all = $('contentAll');
    all.checked = rows.length > 0 && rows.every((c) => selected.has(c.id));
    if (canOrder) $('contentPager').innerHTML = '';
    else renderPager($('contentPager'), list.length, cPage, PER_PAGE, (p) => { cPage = p; renderContent(); }, 'konten');
    renderBulk();
    setupSortable(canOrder);
  }

  // ----- Urutan: seret-lepas (SortableJS, mendukung sentuh) dan panah atas/bawah pada pegangan -----

  let sortable = null;
  function setupSortable(enabled) {
    if (sortable) { sortable.destroy(); sortable = null; }
    if (!enabled) return;
    sortable = Sortable.create($('contentRows'), {
      handle: '.grip',
      animation: 150,
      ghostClass: 'drag-ghost',
      chosenClass: 'drag-chosen',
      forceFallback: false,
      onEnd: () => saveOrder([...$('contentRows').querySelectorAll('tr[data-id]')].map((r) => Number(r.dataset.id))),
    });
  }

  async function saveOrder(ids) {
    const before = contents.map((c) => c.id);
    if (ids.length === before.length && ids.every((id, i) => id === before[i])) return;
    const byId = new Map(contents.map((c) => [c.id, c]));
    contents = ids.map((id) => byId.get(id));
    try {
      await P.api('/api/admin/content/reorder', { method: 'POST', body: { ids } });
      P.toast('Urutan tayang disimpan');
    } catch (e) {
      P.toast(e.status === 409 ? 'Daftar konten berubah. Memuat ulang…' : 'Urutan gagal disimpan: ' + e.message);
      await loadContents();
    }
  }

  $('contentRows').addEventListener('keydown', (e) => {
    const g = e.target.closest('.grip');
    if (!g || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const row = g.closest('tr');
    const other = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
    if (!other || !other.dataset.id) return;
    if (e.key === 'ArrowUp') row.parentNode.insertBefore(row, other); else row.parentNode.insertBefore(other, row);
    g.focus();
    saveOrder([...$('contentRows').querySelectorAll('tr[data-id]')].map((r) => Number(r.dataset.id)));
  });

  function renderBulk() {
    $('bulkbar').classList.toggle('hidden', selected.size === 0);
    $('bulkCount').textContent = selected.size + ' dipilih';
  }

  $('contentTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    cTab = b.dataset.tab; cPage = 1; renderContent();
  });
  $('contentSearch').addEventListener('input', (e) => { cSearch = e.target.value; cPage = 1; renderContent(); });
  $('contentScreenFilter').addEventListener('change', (e) => { cScreen = e.target.value; cPage = 1; renderContent(); });

  $('contentAll').addEventListener('change', (e) => {
    const list = filteredContents().slice((cPage - 1) * PER_PAGE, cPage * PER_PAGE);
    for (const c of list) (e.target.checked ? selected.add(c.id) : selected.delete(c.id));
    renderContent();
  });

  $('contentRows').addEventListener('click', async (e) => {
    const chk = e.target.closest('input[data-sel]');
    if (chk) {
      const id = Number(chk.dataset.sel);
      if (chk.checked) selected.add(id); else selected.delete(id);
      renderContent();
      return;
    }
    const ed = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    if (ed) openContentForm(contents.find((c) => String(c.id) === ed.dataset.edit));
    if (del && confirm('Hapus konten ini?')) {
      await call('/api/admin/content/' + del.dataset.del, { method: 'DELETE' });
      selected.delete(Number(del.dataset.del));
      P.toast('Konten dihapus');
      loadContents();
    }
  });

  $('bulkbar').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-bulk]');
    if (!b) return;
    const action = b.dataset.bulk;
    const n = selected.size;
    if (action === 'delete' && !confirm('Hapus ' + n + ' konten terpilih?')) return;
    try {
      await call('/api/admin/content/bulk', { method: 'POST', body: { ids: [...selected], action } });
      P.toast(n + ' konten ' + ({ activate: 'diaktifkan', deactivate: 'dinonaktifkan', delete: 'dihapus' })[action]);
      selected.clear();
      await loadContents();
    } catch { /* ditangani */ }
  });
  $('bulkClear').addEventListener('click', () => { selected.clear(); renderContent(); });

  // ----- Form konten -----

  let stopConversion = null;
  let cancelUpload = null;
  let busyFile = false; // unggahan atau konversi sedang berjalan

  function setFileStatus(html, busy) {
    $('fileStatus').innerHTML = html || '';
    busyFile = !!busy;
    $('contentSave').disabled = !!busy;
  }

  function progressHtml(label, pct, meta) {
    return '<div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '">' +
      '<div class="prog-top"><span>' + label + '</span><b>' + pct + '%</b></div>' +
      '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
      (meta ? '<div class="prog-meta">' + meta + '</div>' : '') + '</div>';
  }

  const FILE_RULES = {
    image: { accept: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'], hint: 'JPG, PNG, GIF, WEBP, atau SVG. Maksimal 300 MB.' },
    video: { accept: ['mp4', 'webm'], hint: 'MP4 atau WEBM. Video dikonversi ke MP4 (maks. 1080p) di server. Maksimal 300 MB.' },
    pdf: { accept: ['pdf'], hint: 'Berkas PDF. Maksimal 300 MB.' },
  };
  let fileDz = null;
  function buildFileDropzone(type) {
    const rule = FILE_RULES[type];
    if (!rule) { $('fileDz').innerHTML = ''; fileDz = null; return; }
    fileDz = createDropzone($('fileDz'), {
      accept: rule.accept, maxBytes: 300 * 1024 * 1024, icon: I.svg('upload', 'lg'),
      title: 'Seret berkas ke sini', hint: rule.hint,
      onReject: (m) => P.toast(m),
      onFile: handleContentFile,
    });
  }

  function setType() {
    const t = $('ctype').value;
    $('bodyField').classList.toggle('hidden', t !== 'text');
    $('ytField').classList.toggle('hidden', t !== 'youtube');
    $('fileField').classList.toggle('hidden', t === 'text' || t === 'youtube');
    $('durLabel').textContent = t === 'pdf' ? 'Durasi per halaman (detik)' : t === 'youtube' ? 'Durasi maksimum (detik)' : 'Durasi tampil (detik)';
    $('durHint').textContent = t === 'video' ? 'Isi 0 agar video tayang sampai selesai.'
      : t === 'youtube' ? 'Item berganti saat video selesai; isi 0 agar tidak ada batas waktu.'
      : t === 'pdf' ? 'Setiap halaman PDF tampil sebanyak durasi ini, lalu berganti ke halaman berikutnya.' : '';
    if (t !== 'text' && t !== 'youtube') buildFileDropzone(t);
    if (t === 'text') ensureEditor();
  }
  $('ctype').addEventListener('change', () => {
    // Berkas yang sudah terunggah milik jenis lain tidak boleh terbawa.
    if (busyFile) { $('ctype').value = lastType; return P.toast('Tunggu hingga unggahan atau konversi selesai'); }
    lastType = $('ctype').value;
    $('contentForm').elements.file.value = '';
    setFileStatus('', false);
    setType();
  });
  let lastType = 'text';

  // ----- Editor markdown (Tiptap), dimuat malas -----

  let mdEd = null;
  let mdLoading = null;
  let mdPending = '';
  function ensureEditor() {
    if (mdEd) return Promise.resolve(mdEd);
    if (!mdLoading) {
      mdLoading = import('./editor.js').then(({ createMarkdownEditor }) => {
        $('mdEditor').innerHTML = '';
        mdEd = createMarkdownEditor($('mdBar'), $('mdEditor'));
        mdEd.setMarkdown(mdPending);
        return mdEd;
      }).catch((e) => {
        mdLoading = null;
        $('mdEditor').innerHTML = '<div class="status-line"><span class="pill bad">Editor gagal dimuat</span> ' + esc(e.message) + '</div>';
        throw e;
      });
    }
    return mdLoading;
  }

  createDropzone($('mdDz'), {
    accept: ['md', 'markdown', 'txt'], maxBytes: 200 * 1024, icon: I.svg('file', 'lg'),
    title: 'Seret berkas markdown (.md) ke sini', hint: 'Isinya ditambahkan ke editor. Maksimal 200 KB.',
    onReject: (m) => P.toast(m),
    onFile: async (file) => {
      try {
        let text = await file.text();
        const f = $('contentForm').elements;
        // Heading pertama (# Judul) menjadi judul konten bila judul masih kosong.
        const h1 = /^\s*#\s+(.+?)\s*(?:\r?\n|$)/.exec(text);
        if (h1 && !f.title.value.trim()) { f.title.value = h1[1].slice(0, 200); text = text.slice(h1[0].length); }
        const ed = await ensureEditor();
        ed.insertMarkdown(text.trim());
        P.toast('Markdown diimpor: ' + file.name);
      } catch { P.toast('Berkas markdown tidak dapat dibaca'); }
    },
  });

  // ----- YouTube -----

  function updateYtPreview() {
    const v = $('contentForm').elements.url.value.trim();
    const id = parseYoutubeId(v);
    $('ytPreview').innerHTML = !v ? '' : id
      ? '<img alt="" src="' + esc(thumbnailUrl(id)) + '"><div><b>Video dikenali</b><div class="muted">ID: ' + esc(id) + '</div></div>'
      : '<span class="pill bad">Tautan belum dikenali</span> <span class="muted">Contoh: https://www.youtube.com/watch?v=…</span>';
  }
  $('contentForm').elements.url.addEventListener('input', updateYtPreview);

  function openContentForm(c) {
    if (stopConversion) { stopConversion(); stopConversion = null; }
    if (cancelUpload) { cancelUpload(); cancelUpload = null; }
    const f = $('contentForm').elements;
    f.id.value = c ? c.id : '';
    f.type.value = c ? c.type : 'text';
    lastType = f.type.value;
    f.title.value = c ? c.title : '';
    mdPending = c && c.type === 'text' ? c.body : '';
    if (mdEd) mdEd.setMarkdown(mdPending);
    f.url.value = c && c.type === 'youtube' ? c.url : '';
    f.file.value = c ? c.file : '';
    f.duration.value = c ? c.duration : 15;
    f.active.checked = c ? !!c.active : true;
    f.screensaver.checked = c ? !!c.screensaver : false;
    $('ytOption').hidden = $('ytOption').disabled = !!(summary && summary.youtube === false);
    setFileStatus(c && c.file ? '<span class="muted">File saat ini: ' + esc(c.file) + '</span>' : '', false);
    checkboxes($('contentScreens'), screens, c ? c.screens : [], (s) => esc(s.name));
    updateYtPreview();
    setType();
    openDrawer('contentForm', c ? 'Ubah konten' : 'Tambah konten');
  }
  $('addContent').addEventListener('click', () => openContentForm(null));

  async function handleContentFile(file) {
    if (busyFile) return;
    if (stopConversion) { stopConversion(); stopConversion = null; }
    const f = $('contentForm').elements;
    f.file.value = '';
    setFileStatus(progressHtml('Mengunggah ' + esc(file.name), 0, formatBytes(file.size)), true);
    fileDz && fileDz.setDisabled(true);
    try {
      const up = uploadFile(file, (p) => setFileStatus(
        progressHtml('Mengunggah ' + esc(file.name), p.pct, formatBytes(p.loaded) + ' / ' + formatBytes(p.total) + ' · ' + speedText(p.speed) + (p.etaSec != null ? ' · ' + formatEta(p.etaSec) : '')), true));
      cancelUpload = up.abort;
      const r = await up;
      cancelUpload = null;
      f.file.value = r.file;
      if (r.status === 'processing') {
        const show = (pct) => setFileStatus(progressHtml('Mengonversi video ke MP4', pct, 'Boleh menunggu; tombol Simpan aktif setelah selesai.'), true);
        show(0);
        stopConversion = watchConversion(r.file, P.api, {
          onPercent: show,
          onDone: () => { setFileStatus('<span class="pill ok">' + I.svg('check') + 'Video siap</span> <span class="muted">' + esc(file.name) + '</span>', false); fileDz && fileDz.setDisabled(false); },
          onError: (m) => { f.file.value = ''; setFileStatus('<span class="pill bad">Gagal diproses</span> <span class="muted">' + esc(m) + '</span>', false); fileDz && fileDz.setDisabled(false); },
        });
      } else {
        setFileStatus('<span class="pill ok">' + I.svg('check') + 'Terunggah</span> <span class="muted">' + esc(file.name) + ' · ' + formatBytes(file.size) + '</span>' +
          (r.warning ? ' <span class="pill warn">' + esc(r.warning) + '</span>' : ''), false);
        fileDz && fileDz.setDisabled(false);
      }
    } catch (e) {
      cancelUpload = null;
      if (e.status === 401) showLogin('Sesi berakhir. Silakan masuk lagi.');
      setFileStatus('<span class="pill bad">Unggahan gagal</span> <span class="muted">' + esc(e.message) + '</span>', false);
      fileDz && fileDz.setDisabled(false);
    }
  }

  $('contentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busyFile) return P.toast('Tunggu hingga unggahan atau konversi selesai');
    const f = e.target.elements;
    if (f.type.value === 'youtube' && !parseYoutubeId(f.url.value)) return P.toast('Tautan YouTube belum valid');
    let bodyText = '';
    if (f.type.value === 'text') {
      try { bodyText = (await ensureEditor()).getMarkdown(); } catch { return P.toast('Editor belum siap'); }
    }
    const body = {
      type: f.type.value, title: f.title.value, body: bodyText, file: f.file.value, url: f.url.value.trim(),
      duration: Number(f.duration.value),
      active: f.active.checked, screensaver: f.screensaver.checked,
      screens: checkedIds($('contentScreens')),
    };
    try {
      if (f.id.value) await call('/api/admin/content/' + f.id.value, { method: 'PUT', body });
      else await call('/api/admin/content', { method: 'POST', body });
      P.toast('Konten disimpan');
      closeDrawer();
      await loadContents();
    } catch { /* ditangani */ }
  });

  // ---------- Layar ----------

  async function loadScreens() {
    screens = await call('/api/admin/screens');
    $('screensSub').textContent = '(' + screens.length + ')';
    $('screenRows').innerHTML = screens.length
      ? screens.map((s) => {
          const url = '/layar/' + encodeURIComponent(s.slug);
          const cats = s.categoryIds.length
            ? s.categoryIds.map((id) => '<span class="pill">' + esc((categories.find((k) => k.id === id) || {}).name || '?') + '</span>').join('')
            : '<span class="muted">Semua kategori</span>';
          return '<tr><td><div class="who"><span class="avatar sq">' + I.svg('monitor') + '</span><div><div class="n">' + esc(s.name) + '</div><div class="s">' + esc(s.slug) + '</div></div></div></td>' +
            '<td><a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(url) + '</a></td>' +
            '<td>' + (s.showQueue ? '<span class="pill">Antrian + informasi</span>' : '<span class="pill hi">Hanya informasi</span>') + '</td>' +
            '<td><div class="pills">' + (s.showQueue ? cats : '<span class="muted">-</span>') + '</div></td>' +
            '<td>' + (s.idleMinutes ? s.idleMinutes + ' mnt' : '<span class="muted">Umum</span>') + '</td>' +
            '<td><div class="acts"><button class="btn btn-ghost btn-sm btn-icon" data-edit="' + s.id + '" aria-label="Ubah">' + I.svg('edit') + '</button>' +
            '<button class="btn btn-danger btn-sm btn-icon" data-del="' + s.id + '" aria-label="Hapus">' + I.svg('trash') + '</button></div></td></tr>';
        }).join('')
      : '<tr><td colspan="6" class="empty">Belum ada layar. Tanpa layar terdaftar, alamat <b>/</b> menampilkan semua antrian.</td></tr>';
    if (contents.length) renderContent();
  }

  function openScreenForm(s) {
    const f = $('screenForm').elements;
    f.id.value = s ? s.id : '';
    f.name.value = s ? s.name : '';
    f.slug.value = s ? s.slug : '';
    f.idleMinutes.value = s && s.idleMinutes ? s.idleMinutes : '';
    f.showQueue.checked = s ? !!s.showQueue : true;
    f.resumeSeconds.value = s && s.resumeSecondsRaw ? s.resumeSecondsRaw : '';
    syncScreenMode();
    checkboxes($('screenCats'), categories, s ? s.categoryIds : [], (k) => esc(k.name) + ' <span class="muted">(' + esc(k.prefix) + ')</span>');
    openDrawer('screenForm', s ? 'Ubah layar' : 'Tambah layar');
  }
  $('addScreen').addEventListener('click', () => openScreenForm(null));

  $('screenRows').addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    if (ed) openScreenForm(screens.find((s) => String(s.id) === ed.dataset.edit));
    if (del && confirm('Hapus layar ini? Konten khusus layar ini tidak akan tampil di mana pun sampai ditujukan ulang.')) {
      await call('/api/admin/screens/' + del.dataset.del, { method: 'DELETE' });
      await loadScreens();
      loadContents();
    }
  });

  // Mode papan-informasi-saja: kategori tidak relevan, isian "lanjut otomatis" baru berarti.
  function syncScreenMode() {
    const q = $('showQueue').checked;
    $('screenCatsField').classList.toggle('hidden', !q);
    $('resumeField').classList.toggle('hidden', q);
  }
  $('showQueue').addEventListener('change', syncScreenMode);

  $('screenForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const body = {
      name: f.name.value, slug: f.slug.value,
      idleMinutes: f.idleMinutes.value === '' ? null : Number(f.idleMinutes.value),
      categoryIds: checkedIds($('screenCats')),
      showQueue: f.showQueue.checked,
      resumeSeconds: f.resumeSeconds.value === '' ? null : Number(f.resumeSeconds.value),
    };
    try {
      if (f.id.value) await call('/api/admin/screens/' + f.id.value, { method: 'PUT', body });
      else await call('/api/admin/screens', { method: 'POST', body });
      P.toast('Layar disimpan');
      closeDrawer();
      await loadScreens();
      loadContents();
    } catch { /* ditangani */ }
  });

  // ---------- Kategori & meja ----------

  let qTab = 'cats';
  let qSearch = '';
  let qPage = 1;

  async function loadQueue() {
    [categories, counters] = await Promise.all([call('/api/admin/categories'), call('/api/admin/counters')]);
    $('ctrCat').innerHTML = '<option value="">(tanpa kategori)</option>' +
      categories.map((k) => '<option value="' + k.id + '">' + esc(k.name) + ' (' + esc(k.prefix) + ')</option>').join('');
    renderQueue();
  }

  function renderQueue() {
    $('queueTabs').innerHTML =
      '<button role="tab" class="' + (qTab === 'cats' ? 'on' : '') + '" data-tab="cats">Kategori <span class="n">' + categories.length + '</span></button>' +
      '<button role="tab" class="' + (qTab === 'ctrs' ? 'on' : '') + '" data-tab="ctrs">Meja <span class="n">' + counters.length + '</span></button>';
    $('addQueueLbl').textContent = qTab === 'cats' ? 'Tambah kategori' : 'Tambah meja';
    const q = qSearch.trim().toLowerCase();
    let list;
    let rowFn;
    if (qTab === 'cats') {
      $('queueHead').innerHTML = '<tr><th>Prefix</th><th>Kategori</th><th>Meja</th><th></th></tr>';
      list = categories.filter((k) => !q || (k.name + k.prefix).toLowerCase().includes(q));
      rowFn = (k) => {
        const mine = counters.filter((c) => c.category_id === k.id);
        return '<tr><td><span class="pill hi">' + esc(k.prefix) + '</span></td><td class="n">' + esc(k.name) + '</td>' +
          '<td>' + (mine.length ? mine.map((c) => '<span class="pill">' + esc(c.name) + '</span>').join(' ') : '<span class="muted">Belum ada</span>') + '</td>' +
          '<td><div class="acts"><button class="btn btn-ghost btn-sm btn-icon" data-ckedit="' + k.id + '" aria-label="Ubah">' + I.svg('edit') + '</button>' +
          '<button class="btn btn-danger btn-sm btn-icon" data-ckdel="' + k.id + '" aria-label="Hapus">' + I.svg('trash') + '</button></div></td></tr>';
      };
    } else {
      $('queueHead').innerHTML = '<tr><th>Meja</th><th>Kategori</th><th>Status</th><th></th></tr>';
      list = counters.filter((c) => !q || (c.name + (c.categoryName || '')).toLowerCase().includes(q));
      rowFn = (c) => '<tr><td><div class="who"><span class="avatar sq">' + esc((/(\d+)\s*$/.exec(c.name) || [, I.initials(c.name)])[1]) + '</span><div class="n">' + esc(c.name) + '</div></div></td>' +
        '<td>' + (c.categoryName ? '<span class="pill">' + esc(c.categoryName) + '</span>' : '<span class="muted">Tanpa kategori</span>') + '</td>' +
        '<td><span class="pill ' + (c.active ? 'ok' : 'off') + '"><span class="dot"></span>' + (c.active ? 'Aktif' : 'Nonaktif') + '</span></td>' +
        '<td><div class="acts"><button class="btn btn-ghost btn-sm btn-icon" data-ctedit="' + c.id + '" aria-label="Ubah">' + I.svg('edit') + '</button>' +
        '<button class="btn btn-danger btn-sm btn-icon" data-ctdel="' + c.id + '" aria-label="Hapus">' + I.svg('trash') + '</button></div></td></tr>';
    }
    qPage = clampPage(qPage, list.length, PER_PAGE);
    const rows = list.slice((qPage - 1) * PER_PAGE, qPage * PER_PAGE);
    $('queueRows').innerHTML = rows.length ? rows.map(rowFn).join('') : '<tr><td colspan="4" class="empty">Belum ada data.</td></tr>';
    renderPager($('queuePager'), list.length, qPage, PER_PAGE, (p) => { qPage = p; renderQueue(); }, qTab === 'cats' ? 'kategori' : 'meja');
  }

  $('queueTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) { qTab = b.dataset.tab; qPage = 1; renderQueue(); }
  });
  $('queueSearch').addEventListener('input', (e) => { qSearch = e.target.value; qPage = 1; renderQueue(); });

  function openCatForm(k) {
    const f = $('catForm').elements;
    f.id.value = k ? k.id : '';
    f.name.value = k ? k.name : '';
    f.prefix.value = k ? k.prefix : '';
    openDrawer('catForm', k ? 'Ubah kategori' : 'Tambah kategori');
  }

  function openCtrForm(c) {
    const f = $('ctrForm').elements;
    f.id.value = c ? c.id : '';
    f.name.value = c ? c.name : '';
    f.categoryId.value = c && c.category_id ? c.category_id : '';
    f.active.checked = c ? !!c.active : true;
    openDrawer('ctrForm', c ? 'Ubah meja' : 'Tambah meja');
  }
  $('addQueue').addEventListener('click', () => (qTab === 'cats' ? openCatForm(null) : openCtrForm(null)));

  $('queueRows').addEventListener('click', async (e) => {
    const t = (a) => e.target.closest('[' + a + ']');
    if (t('data-ckedit')) openCatForm(categories.find((k) => String(k.id) === t('data-ckedit').dataset.ckedit));
    if (t('data-ctedit')) openCtrForm(counters.find((c) => String(c.id) === t('data-ctedit').dataset.ctedit));
    if (t('data-ckdel') && confirm('Hapus kategori? Antrian terkait ikut terhapus.')) {
      await call('/api/admin/categories/' + t('data-ckdel').dataset.ckdel, { method: 'DELETE' });
      await loadQueue(); loadScreens();
    }
    if (t('data-ctdel') && confirm('Hapus meja ini?')) {
      await call('/api/admin/counters/' + t('data-ctdel').dataset.ctdel, { method: 'DELETE' });
      await loadQueue(); loadUsers();
    }
  });

  $('catForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const body = { name: f.name.value, prefix: f.prefix.value };
    try {
      if (f.id.value) await call('/api/admin/categories/' + f.id.value, { method: 'PUT', body });
      else await call('/api/admin/categories', { method: 'POST', body });
      P.toast('Kategori disimpan');
      closeDrawer();
      await loadQueue();
    } catch { /* ditangani */ }
  });

  $('ctrForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const body = { name: f.name.value, categoryId: f.categoryId.value || null, active: f.active.checked };
    try {
      if (f.id.value) await call('/api/admin/counters/' + f.id.value, { method: 'PUT', body });
      else await call('/api/admin/counters', { method: 'POST', body });
      P.toast('Meja disimpan');
      closeDrawer();
      await loadQueue();
      loadUsers();
    } catch { /* ditangani */ }
  });

  // ---------- Pegawai ----------

  let uSearch = '';
  let uRole = '';
  let uStatus = '';
  let uPage = 1;

  async function loadUsers() {
    users = await call('/api/admin/users');
    renderUsers();
  }

  function renderUsers() {
    $('usersSub').textContent = '(' + users.length + ')';
    const q = uSearch.trim().toLowerCase();
    const list = users.filter((u) =>
      (!q || (u.name + ' ' + u.username).toLowerCase().includes(q)) &&
      (!uRole || u.role === uRole) && (uStatus === '' || String(u.active) === uStatus));
    uPage = clampPage(uPage, list.length, PER_PAGE);
    const rows = list.slice((uPage - 1) * PER_PAGE, uPage * PER_PAGE);
    $('userRows').innerHTML = rows.length
      ? rows.map((u) => {
          const ctr = u.role === 'admin' ? '<span class="muted">Semua meja</span>'
            : (u.counterIds.length ? names(u.counterIds, counters).map((n) => '<span class="pill">' + esc(n) + '</span>').join(' ') : '<span class="muted">Belum ada</span>');
          return '<tr><td><div class="who"><span class="avatar' + (u.role === 'admin' ? ' y' : '') + '">' + esc(I.initials(u.name)) + '</span><div><div class="n">' + esc(u.name) + '</div><div class="s">' + esc(u.username) + '</div></div></div></td>' +
            '<td>' + (u.role === 'admin' ? '<span class="pill hi">Admin</span>' : '<span class="pill">Pegawai</span>') + '</td>' +
            '<td><div class="pills">' + ctr + '</div></td>' +
            '<td><span class="pill ' + (u.active ? 'ok' : 'off') + '"><span class="dot"></span>' + (u.active ? 'Aktif' : 'Nonaktif') + '</span></td>' +
            '<td><div class="acts"><button class="btn btn-ghost btn-sm btn-icon" data-uedit="' + u.id + '" aria-label="Ubah">' + I.svg('edit') + '</button>' +
            '<button class="btn btn-danger btn-sm btn-icon" data-udel="' + u.id + '" aria-label="Hapus"' + (me && u.id === me.id ? ' disabled' : '') + '>' + I.svg('trash') + '</button></div></td></tr>';
        }).join('')
      : '<tr><td colspan="5" class="empty">Tidak ada pegawai yang cocok.</td></tr>';
    renderPager($('userPager'), list.length, uPage, PER_PAGE, (p) => { uPage = p; renderUsers(); }, 'pegawai');
  }

  $('userSearch').addEventListener('input', (e) => { uSearch = e.target.value; uPage = 1; renderUsers(); });
  $('userRoleFilter').addEventListener('change', (e) => { uRole = e.target.value; uPage = 1; renderUsers(); });
  $('userStatusFilter').addEventListener('change', (e) => { uStatus = e.target.value; uPage = 1; renderUsers(); });

  function openUserForm(u) {
    const f = $('userForm').elements;
    f.id.value = u ? u.id : '';
    f.name.value = u ? u.name : '';
    f.username.value = u ? u.username : '';
    f.password.value = '';
    f.role.value = u ? u.role : 'staff';
    f.active.checked = u ? !!u.active : true;
    $('pwLabel').textContent = u ? 'Password baru (kosongkan jika tidak diganti)' : 'Password (minimal 8 karakter)';
    checkboxes($('userCounters'), counters, u ? u.counterIds : [], (c) => esc(c.name) + (c.categoryName ? ' <span class="muted">· ' + esc(c.categoryName) + '</span>' : ''));
    openDrawer('userForm', u ? 'Ubah pegawai' : 'Tambah pegawai');
  }
  $('addUser').addEventListener('click', () => openUserForm(null));

  $('userRows').addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-uedit]');
    const del = e.target.closest('[data-udel]');
    if (ed) openUserForm(users.find((u) => String(u.id) === ed.dataset.uedit));
    if (del && !del.disabled && confirm('Hapus akun pegawai ini?')) {
      try {
        await call('/api/admin/users/' + del.dataset.udel, { method: 'DELETE' });
        P.toast('Pegawai dihapus');
        loadUsers();
      } catch { /* ditangani */ }
    }
  });

  $('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const body = {
      name: f.name.value, username: f.username.value, password: f.password.value, role: f.role.value,
      active: f.active.checked, counterIds: checkedIds($('userCounters')),
    };
    try {
      if (f.id.value) await call('/api/admin/users/' + f.id.value, { method: 'PUT', body });
      else await call('/api/admin/users', { method: 'POST', body });
      P.toast('Pegawai disimpan');
      closeDrawer();
      await loadUsers();
    } catch { /* ditangani */ }
  });

  // ---------- Pengaturan ----------

  function applyBrand(s) {
    $('brandName').textContent = s.org_name || 'Papan Informasi';
    const av = $('brandAv');
    if (s.org_logo) {
      av.innerHTML = '<img src="' + esc(s.org_logo) + '" alt="" style="width:100%;height:100%;object-fit:contain;border-radius:inherit">';
      av.style.background = '#fff';
    } else {
      av.textContent = I.initials(s.org_name || 'P');
      av.style.background = '';
    }
  }

  // Menjelaskan alamat yang akan dipakai kode QR dan apakah push bisa berjalan di sana.
  function describeNotify() {
    const f = $('settingsForm').elements;
    const typed = f.public_base_url.value.trim().replace(/\/+$/, '');
    const effective = typed || location.origin;
    let host = '';
    let https = false;
    try {
      const u = new URL(effective);
      host = u.hostname;
      https = u.protocol === 'https:';
    } catch { /* alamat belum valid; ditolak server saat disimpan */ }
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
    $('baseHint').innerHTML = 'Kode QR akan mengarah ke <b>' + esc(effective) + '/antrian/…</b>' +
      (local ? '<br><span style="color:var(--red)">Alamat ini tidak bisa dibuka dari ponsel pengunjung. Isi dengan alamat IP atau nama server di jaringan, mis. http://192.168.1.10:3000.</span>' : '');
    $('pushHint').textContent = !f.push_enabled.checked
      ? 'Dimatikan. Halaman pantau tetap memberi peringatan suara dan getar selama dibuka.'
      : https
        ? 'Aktif. Pengunjung bisa menerima notifikasi walau halaman ditutup.'
        : 'Hanya berjalan bila pengunjung membuka situs lewat HTTPS. Lewat HTTP, peringatan suara dan getar tetap bekerja selama halaman pantau dibuka.';
  }
  document.addEventListener('input', (e) => {
    if (e.target.closest && e.target.closest('#settingsForm')) describeNotify();
  });

  async function loadSettings() {
    const s = await P.api('/api/settings');
    const f = $('settingsForm').elements;
    f.org_name.value = s.org_name || '';
    f.org_logo.value = s.org_logo || '';
    f.idle_minutes.value = s.idle_minutes || '3';
    f.timezone.value = s.timezone || 'Asia/Jakarta';
    f.sound_enabled.checked = s.sound_enabled !== '0';
    f.tts_enabled.checked = s.tts_enabled !== '0';
    f.priority_enabled.checked = s.priority_enabled === '1';
    f.public_base_url.value = s.public_base_url || '';
    f.notify_ahead.value = s.notify_ahead || '3';
    f.push_enabled.checked = s.push_enabled !== '0';
    describeNotify();
    $('logoPreview').src = s.org_logo || '';
    $('logoPreview').style.visibility = s.org_logo ? 'visible' : 'hidden';
    applyBrand(s);
  }

  createDropzone($('logoDz'), {
    accept: ['png', 'jpg', 'jpeg', 'svg', 'webp'], maxBytes: 5 * 1024 * 1024, icon: I.svg('image', 'lg'),
    title: 'Seret logo ke sini', hint: 'PNG, JPG, SVG, atau WEBP. Maksimal 5 MB.',
    onReject: (m) => P.toast(m),
    onFile: async (file) => {
      const st = $('logoStatus');
      st.innerHTML = '<div class="prog"><div class="prog-top"><span>Mengunggah ' + esc(file.name) + '</span><b>0%</b></div><div class="bar"><i style="width:0%"></i></div></div>';
      try {
        const r = await uploadFile(file, (p) => {
          st.querySelector('b').textContent = p.pct + '%';
          st.querySelector('i').style.width = p.pct + '%';
        });
        $('settingsForm').elements.org_logo.value = r.url;
        $('logoPreview').src = r.url;
        $('logoPreview').style.visibility = 'visible';
        st.innerHTML = '<span class="pill ok">' + I.svg('check') + 'Terunggah</span> <span class="muted">Klik Simpan pengaturan.</span>';
      } catch (e) {
        if (e.status === 401) showLogin('Sesi berakhir. Silakan masuk lagi.');
        st.innerHTML = '<span class="pill bad">Unggahan gagal</span> <span class="muted">' + esc(e.message) + '</span>';
      }
    },
  });

  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const flag = (el) => (el.checked ? '1' : '0');
    try {
      await call('/api/admin/settings', {
        method: 'PUT',
        body: {
          org_name: f.org_name.value, org_logo: f.org_logo.value, idle_minutes: f.idle_minutes.value,
          timezone: f.timezone.value, sound_enabled: flag(f.sound_enabled), tts_enabled: flag(f.tts_enabled),
          priority_enabled: flag(f.priority_enabled),
          public_base_url: f.public_base_url.value.trim(), notify_ahead: f.notify_ahead.value,
          push_enabled: flag(f.push_enabled),
        },
      });
      P.toast('Pengaturan disimpan');
      loadSettings();
    } catch { /* ditangani */ }
  });

  // ---------- Laporan ----------

  async function loadReport() {
    const r = await call('/api/admin/report');
    $('reportCats').innerHTML = r.categories.map((c) =>
      '<tr><td><div class="n">' + esc(c.name) + ' <span class="pill hi">' + esc(c.prefix) + '</span></div></td>' +
      '<td class="num">' + (c.total || 0) + '</td><td class="num">' + (c.done || 0) + '</td><td class="num">' + (c.skipped || 0) + '</td><td class="num">' + (c.waiting || 0) + '</td></tr>'
    ).join('') || '<tr><td colspan="5" class="empty">Belum ada data</td></tr>';
    $('reportStaff').innerHTML = r.staff.map((s) =>
      '<tr><td><div class="who"><span class="avatar">' + esc(I.initials(s.name)) + '</span><div><div class="n">' + esc(s.name) + '</div><div class="s">' + esc(s.username) + '</div></div></div></td>' +
      '<td class="num">' + (s.total || 0) + '</td><td class="num">' + (s.done || 0) + '</td><td class="num">' + (s.skipped || 0) + '</td></tr>'
    ).join('') || '<tr><td colspan="4" class="empty">Belum ada antrian yang dilayani hari ini</td></tr>';
  }
  $('reloadReport').addEventListener('click', () => loadReport().catch(() => {}));

  // ---------- Init ----------

  hydrateIcons();
  setType();
  enter();
  // Dasbor ikut hidup: angka antrian diperbarui saat ada perubahan.
  P.connectWS((msg) => {
    if (!me || $('shell').classList.contains('hidden')) return;
    if (msg.type === 'queue' && page === 'dashboard') loadSummary().catch(() => {});
  });

  // ---------- Tabel -> kartu di ponsel: label kolom dari <th> ----------

  function labelTables() {
    document.querySelectorAll('.tbl-wrap table').forEach((t) => {
      const heads = t.tHead && t.tHead.rows[0] ? [...t.tHead.rows[0].cells].map((c) => c.textContent.trim()) : [];
      for (const b of t.tBodies) {
        for (const r of b.rows) {
          [...r.cells].forEach((c, i) => {
            if (c.colSpan > 1 || !heads[i]) delete c.dataset.label;
            else if (c.dataset.label !== heads[i]) c.dataset.label = heads[i];
          });
        }
      }
    });
  }
  let labelQueued = false;
  const labelObserver = new MutationObserver(() => {
    if (labelQueued) return;
    labelQueued = true;
    requestAnimationFrame(() => { labelQueued = false; labelTables(); });
  });
  document.querySelectorAll('.tbl-wrap tbody, .tbl-wrap thead').forEach((el) => labelObserver.observe(el, { childList: true }));
  labelTables();
})();
