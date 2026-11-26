// Editor teks pengumuman: Tiptap dengan penyimpanan Markdown. Dimuat malas (import()) hanya saat form teks dibuka.
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';

const MD_HINT = /^(#{1,4}\s|[-*+]\s|\d+\.\s|>\s|---+\s*$)/m;

const BUTTONS = [
  { id: 'bold', label: 'B', title: 'Tebal', cls: 'b', run: (c) => c.toggleBold(), active: (e) => e.isActive('bold') },
  { id: 'italic', label: 'I', title: 'Miring', cls: 'i', run: (c) => c.toggleItalic(), active: (e) => e.isActive('italic') },
  { id: 'h1', label: 'H1', title: 'Judul besar', run: (c) => c.toggleHeading({ level: 1 }), active: (e) => e.isActive('heading', { level: 1 }) },
  { id: 'h2', label: 'H2', title: 'Judul sedang', run: (c) => c.toggleHeading({ level: 2 }), active: (e) => e.isActive('heading', { level: 2 }) },
  { id: 'h3', label: 'H3', title: 'Judul kecil', run: (c) => c.toggleHeading({ level: 3 }), active: (e) => e.isActive('heading', { level: 3 }) },
  { id: 'ul', label: '• Daftar', title: 'Daftar poin', run: (c) => c.toggleBulletList(), active: (e) => e.isActive('bulletList') },
  { id: 'ol', label: '1. Daftar', title: 'Daftar bernomor', run: (c) => c.toggleOrderedList(), active: (e) => e.isActive('orderedList') },
  { id: 'quote', label: '“ Kutipan', title: 'Kutipan', run: (c) => c.toggleBlockquote(), active: (e) => e.isActive('blockquote') },
  { id: 'hr', label: '―', title: 'Garis pemisah', run: (c) => c.setHorizontalRule(), active: () => false },
];

/**
 * @param {HTMLElement} bar   wadah bilah alat
 * @param {HTMLElement} area  wadah editor
 * @param {{onChange?: (md: string) => void}} opt
 */
export function createMarkdownEditor(bar, area, opt = {}) {
  // Hanya elemen yang bisa dihasilkan lagi sebagai markdown dan ditampilkan papan (lihat markdown.js).
  const editor = new Editor({
    element: area,
    extensions: [
      StarterKit.configure({ link: false, underline: false, strike: false, code: false, codeBlock: false, heading: { levels: [1, 2, 3] } }),
      Markdown,
    ],
    content: '',
    contentType: 'markdown',
    editorProps: {
      attributes: { class: 'md-doc', 'aria-label': 'Isi teks pengumuman', spellcheck: 'true' },
      // Menempel teks markdown mentah (bukan HTML) dikonversi menjadi format, bukan dimasukkan sebagai karakter.
      handlePaste: (view, event) => {
        const cd = event.clipboardData;
        if (!cd || cd.types.includes('text/html')) return false;
        const text = cd.getData('text/plain');
        if (!text || !MD_HINT.test(text)) return false;
        editor.commands.insertContent(text, { contentType: 'markdown' });
        return true;
      },
    },
    onUpdate: () => opt.onChange && opt.onChange(editor.getMarkdown()),
    onSelectionUpdate: refresh,
    onTransaction: refresh,
  });

  bar.innerHTML = BUTTONS.map((b) =>
    '<button type="button" class="mdb ' + (b.cls || '') + '" data-md="' + b.id + '" title="' + b.title + '" aria-label="' + b.title + '">' + b.label + '</button>').join('');
  bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // jaga fokus editor
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-md]');
    if (!btn) return;
    const def = BUTTONS.find((b) => b.id === btn.dataset.md);
    def.run(editor.chain().focus()).run();
  });
  function refresh() {
    for (const b of BUTTONS) {
      const el = bar.querySelector('[data-md="' + b.id + '"]');
      if (el) el.classList.toggle('on', !!b.active(editor));
    }
  }

  return {
    setMarkdown(md) { editor.commands.setContent(md || '', { contentType: 'markdown', emitUpdate: false }); refresh(); },
    getMarkdown() { return editor.getMarkdown(); },
    insertMarkdown(md) { editor.chain().focus('end').insertContent(md, { contentType: 'markdown' }).run(); },
    focus() { editor.commands.focus(); },
    destroy() { editor.destroy(); bar.innerHTML = ''; },
  };
}
