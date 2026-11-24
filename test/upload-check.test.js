import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkUpload } from '../server/upload-check.js';
import { tmpDir } from './helpers.js';

const dir = tmpDir('uc-');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
function check(ext, data) {
  const p = path.join(dir, `f${n++}${ext}`);
  fs.writeFileSync(p, data);
  return checkUpload(p, ext);
}
const bin = (...a) => Buffer.from(a);
const pad = (head, len = 64) => Buffer.concat([head, Buffer.alloc(len)]);
const ascii = (s) => Buffer.from(s, 'latin1');
const SVG = (inner) => `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

describe('upload-check: berkas biner', () => {
  const valid = {
    '.png': pad(bin(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    '.jpg': pad(bin(0xff, 0xd8, 0xff, 0xe0)),
    '.jpeg': pad(bin(0xff, 0xd8, 0xff, 0xe1)),
    '.gif': pad(ascii('GIF89a')),
    '.webp': pad(Buffer.concat([ascii('RIFF'), bin(1, 2, 3, 4), ascii('WEBP')])),
    '.pdf': ascii('%PDF-1.4\n1 0 obj\n'),
    '.mp4': pad(Buffer.concat([bin(0, 0, 0, 0x18), ascii('ftypisom')])),
    '.webm': pad(bin(0x1a, 0x45, 0xdf, 0xa3)),
  };
  for (const [ext, data] of Object.entries(valid)) {
    it(`menerima ${ext} yang tanda tangannya sesuai`, () => assert.equal(check(ext, data).ok, true));
  }

  it('menolak HTML yang dinamai .png', () => {
    const r = check('.png', ascii('<html><script>alert(1)</script></html>'));
    assert.equal(r.ok, false);
    assert.match(r.reason, /tidak sesuai/);
  });
  it('menolak skrip yang dinamai .jpg', () => assert.equal(check('.jpg', ascii('#!/bin/sh\nrm -rf /\n')).ok, false));
  it('menolak PNG yang dinamai .pdf', () => assert.equal(check('.pdf', valid['.png']).ok, false));
  it('menolak JPEG yang dinamai .mp4', () => assert.equal(check('.mp4', valid['.jpg']).ok, false));
  it('menolak RIFF yang bukan WEBP (WAV)', () => {
    assert.equal(check('.webp', pad(Buffer.concat([ascii('RIFF'), bin(1, 2, 3, 4), ascii('WAVE')]))).ok, false);
  });
  it('menolak berkas kosong', () => assert.match(check('.png', Buffer.alloc(0)).reason, /kosong/));
  it('menolak ekstensi yang tidak dikenal', () => assert.match(check('.exe', ascii('MZ')).reason, /tidak didukung/));
});

describe('upload-check: SVG', () => {
  it('menerima SVG polos', () => assert.equal(check('.svg', SVG('<rect width="9" height="9" fill="#2f6df0"/>')).ok, true));
  it('menerima SVG dengan deklarasi XML, komentar, dan DOCTYPE', () => {
    const s = '<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' + SVG('<path d="M0 0h9v9z"/>');
    assert.equal(check('.svg', s).ok, true);
  });
  it('menerima SVG ber-BOM', () => assert.equal(check('.svg', '﻿' + SVG('<circle r="4"/>')).ok, true));
  it('menerima xmlns:xlink yang bukan href', () => {
    const s = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg>';
    assert.equal(check('.svg', s).ok, true);
  });
  it('menerima href internal #id (kutip ganda dan tunggal)', () => {
    assert.equal(check('.svg', SVG('<defs><path id="a" d="M0 0"/></defs><use href="#a"/>')).ok, true);
    assert.equal(check('.svg', SVG("<defs><path id='a' d='M0 0'/></defs><use xlink:href='#a'/>")).ok, true);
  });
  it('menerima gambar data:image PNG', () => assert.equal(check('.svg', SVG('<image href="data:image/png;base64,iVBORw0KGgo="/>')).ok, true));

  const forbidden = {
    '<script>': [SVG('<script>alert(1)</script>'), /<script>/],
    '<SCRIPT> huruf besar': [SVG('<SCRIPT>alert(1)</SCRIPT>'), /<script>/],
    '< script bersepasi': [SVG('< script>alert(1)</ script>'), /<script>/],
    'onload=': ['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', /penangan peristiwa/],
    'onclick = dengan spasi': [SVG('<rect onclick = "alert(1)"/>'), /penangan peristiwa/],
    'javascript: pada href': [SVG('<a href="javascript:alert(1)"><text>x</text></a>'), null],
    'href https eksternal': [SVG('<image href="https://evil.example/t.png"/>'), /href/],
    'xlink:href eksternal': [SVG('<use xlink:href="http://evil.example/a.svg#x"/>'), /href/],
    'href tanpa kutip eksternal': [SVG('<image href=http://evil.example/x.png />'), /href/],
    'href dengan entitas penyamar javascript:': [SVG('<a href="&#106;avascript:alert(1)"><text>x</text></a>'), /href/],
    'data:text/html': [SVG('<image href="data:text/html;base64,PHNjcmlwdD4="/>'), null],
    '<foreignObject>': [SVG('<foreignObject><div>x</div></foreignObject>'), /foreignObject/],
    '<iframe>': [SVG('<iframe src="x"/>'), null],
    'CSS @import': [SVG('<style>@import url(x.css);</style>'), /@import/],
    'CSS url() eksternal': [SVG('<rect style="fill:url(https://evil.example/x)"/>'), /CSS/],
    'HTML yang dinamai .svg': ['<html><body>halo</body></html>', /bukan SVG/],
    'teks biasa': ['halo dunia', /bukan SVG/],
  };
  for (const [name, [content, reason]] of Object.entries(forbidden)) {
    it(`menolak ${name}`, () => {
      const r = check('.svg', content);
      assert.equal(r.ok, false);
      if (reason) assert.match(r.reason, reason);
    });
  }
  it('menolak SVG di atas 2 MB', () => {
    const r = check('.svg', SVG('<!--' + 'x'.repeat(2 * 1024 * 1024) + '-->'));
    assert.equal(r.ok, false);
    assert.match(r.reason, /2 MB/);
  });
});
