// Build frontend: halaman HTML di web/ menjadi dist/ yang disajikan server. Tanpa framework; modul ES biasa.
import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(root, 'web');

// Font standar pdf.js (untuk PDF yang tidak menyematkan font) disalin ke dist/pdf-fonts.
function pdfFonts() {
  return {
    name: 'papan-pdf-fonts',
    closeBundle() {
      const src = path.join(root, 'node_modules', 'pdfjs-dist', 'standard_fonts');
      if (fs.existsSync(src)) fs.cpSync(src, path.join(root, 'dist', 'pdf-fonts'), { recursive: true });
    },
  };
}

export default defineConfig({
  root: web,
  publicDir: path.join(web, 'static'),
  plugins: [pdfFonts()],
  build: {
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: Object.fromEntries(
        ['display', 'kiosk', 'operator', 'admin', 'antrian'].map((n) => [n, path.join(web, `${n}.html`)]),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/uploads': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
