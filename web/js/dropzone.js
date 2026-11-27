// Area seret-lepas untuk memilih berkas. Juga bisa diklik atau dibuka dengan keyboard (Enter/Spasi).
// Tidak mengunggah apa pun sendiri: memanggil onFile(file) untuk satu berkas yang lolos pemeriksaan tipe dan ukuran.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

/**
 * @param {HTMLElement} root  wadah; isinya diganti
 * @param {{accept: string[], maxBytes?: number, icon?: string, title?: string, hint?: string,
 *          onFile: (f: File) => void, onReject?: (msg: string) => void}} opt  accept = daftar ekstensi tanpa titik
 */
export function createDropzone(root, opt) {
  const accept = opt.accept.map((e) => e.toLowerCase().replace(/^\./, ''));
  root.innerHTML =
    '<div class="dz" tabindex="0" role="button" aria-label="' + esc(opt.title || 'Pilih berkas') + '">' +
    (opt.icon || '') +
    '<div class="dz-t"><span class="dz-desk">' + esc(opt.title || 'Seret berkas ke sini') + ' <span class="dz-link">atau pilih dari komputer</span></span>' +
    '<span class="dz-touch"><span class="dz-link">Ketuk untuk memilih berkas</span></span></div>' +
    '<div class="dz-h">' + esc(opt.hint || '') + '</div>' +
    '<input type="file" hidden accept="' + accept.map((e) => '.' + e).join(',') + '"></div>';
  const box = root.querySelector('.dz');
  const input = root.querySelector('input');

  const reject = (msg) => (opt.onReject ? opt.onReject(msg) : alert(msg));
  function take(file) {
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!accept.includes(ext)) return reject('Jenis berkas ".' + ext + '" tidak didukung. Yang diterima: ' + accept.join(', ').toUpperCase() + '.');
    if (opt.maxBytes && file.size > opt.maxBytes) return reject('Berkas terlalu besar (' + formatBytes(file.size) + '). Maksimal ' + formatBytes(opt.maxBytes) + '.');
    if (file.size === 0) return reject('Berkas kosong.');
    opt.onFile(file);
  }

  box.addEventListener('click', () => input.click());
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => { take(input.files[0]); input.value = ''; });

  // dragenter/leave memicu berulang saat melewati elemen anak; hitung agar sorotan tidak berkedip.
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  box.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth += 1; box.classList.add('over'); });
  box.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  box.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) box.classList.remove('over'); });
  box.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    box.classList.remove('over');
    if (e.dataTransfer.files.length > 1) return reject('Seret satu berkas saja.');
    take(e.dataTransfer.files[0]);
  });

  return {
    setDisabled(v) { box.classList.toggle('disabled', !!v); box.setAttribute('aria-disabled', v ? 'true' : 'false'); input.disabled = !!v; },
    element: box,
  };
}
