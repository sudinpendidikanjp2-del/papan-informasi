// Markdown pengumuman -> HTML aman. Isi berasal dari admin tetapi tetap disanitasi: tanpa atribut apa pun, tanpa
// tautan aktif (papan mode kiosk tidak boleh berpindah halaman), tanpa gambar/iframe/skrip.
import { Marked } from 'marked';
import DOMPurify from 'dompurify';

// Lapis pertama: HTML mentah di dalam markdown dibuang, gambar menjadi teks alternatif, dan tautan menjadi teks biasa.
// Editor tidak pernah menghasilkan HTML, jadi tidak ada yang hilang; ini juga mencegah markup berbahaya sampai ke
// parser DOM (yang di dokumen ber-CSP tetap memicu laporan pelanggaran walau tidak dieksekusi).
const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html() { return ''; },
    image(token) { return token.text ? this.parser.parseInline(token.tokens || []) || token.text : ''; },
    link(token) { return this.parser.parseInline(token.tokens || []); },
  },
});

// Lapis kedua: DOMPurify dengan daftar tag sempit dan tanpa atribut.
const ALLOWED_TAGS = ['h1', 'h2', 'h3', 'h4', 'p', 'strong', 'em', 'b', 'i', 'del', 'ul', 'ol', 'li', 'blockquote', 'hr', 'br', 'code', 'pre'];

export function renderMarkdown(md_) {
  const raw = md.parse(String(md_ || ''), { async: false });
  return DOMPurify.sanitize(raw, { ALLOWED_TAGS, ALLOWED_ATTR: [], KEEP_CONTENT: true });
}
