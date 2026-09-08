/**
 * 検証用のサンプル平面図PDFを作る（node tools/make_sample_pdf.js）。
 *
 * 会社の実図面はリポジトリに置かないので、縮尺較正や寸法の検算はこれで行う。
 * A3横・縮尺1:50、室内 12,000 × 8,000 mm。通り芯は 6,000 ピッチ。
 * 外部ライブラリは使わず、PDFを直接組み立てている（依存を増やさないため）。
 */

const fs = require('fs');
const path = require('path');

const MM = 72 / 25.4;            // mm → pt
const SCALE = 50;                // 図面の縮尺 1:50
const real = (mm) => (mm / SCALE) * MM; // 実寸mm → pt

// A3 横
const PAGE_W = 420 * MM;
const PAGE_H = 297 * MM;

// 図面原点（用紙左下から）
const OX = 60 * MM;
const OY = 70 * MM;

const ROOM_W = 12000; // 実寸mm
const ROOM_H = 8000;
const WALL = 200;

const out = [];
const cmd = (s) => out.push(s);

const X = (mm) => (OX + real(mm)).toFixed(2);
const Y = (mm) => (OY + real(mm)).toFixed(2);

function line(x1, y1, x2, y2, w = 0.4) {
  cmd(`${w} w ${X(x1)} ${Y(y1)} m ${X(x2)} ${Y(y2)} l S`);
}
function rect(x, y, w, h, lw = 0.4) {
  cmd(`${lw} w ${X(x)} ${Y(y)} ${real(w).toFixed(2)} ${real(h).toFixed(2)} re S`);
}
function fillRect(x, y, w, h, g = 0.75) {
  cmd(`${g} g ${X(x)} ${Y(y)} ${real(w).toFixed(2)} ${real(h).toFixed(2)} re f 0 g`);
}
function text(str, xMm, yMm, size = 8) {
  cmd(`BT /F1 ${size} Tf ${X(xMm)} ${Y(yMm)} Td (${str}) Tj ET`);
}
function textPt(str, xPt, yPt, size = 8) {
  cmd(`BT /F1 ${size} Tf ${xPt.toFixed(2)} ${yPt.toFixed(2)} Td (${str}) Tj ET`);
}

cmd('0 G 0 g');

// 壁（外側・内側の二重線）
rect(-WALL, -WALL, ROOM_W + WALL * 2, ROOM_H + WALL * 2, 1.2);
rect(0, 0, ROOM_W, ROOM_H, 1.2);

// 柱 600×600 を通り芯上に
for (const gx of [0, 6000, 12000]) {
  for (const gy of [0, 8000]) {
    fillRect(gx - 300, gy - 300, 600, 600, 0.6);
    rect(gx - 300, gy - 300, 600, 600, 0.6);
  }
}

// 通り芯（一点鎖線のかわりに細線）
cmd('[3 2] 0 d 0.25 w');
for (const gx of [0, 6000, 12000]) line(gx, -1200, gx, ROOM_H + 1200, 0.25);
for (const gy of [0, 8000]) line(-1200, gy, ROOM_W + 1200, gy, 0.25);
cmd('[] 0 d');

// 出入口（下辺に開口 1,600）
cmd('1 G');
line(5200, 0, 6800, 0, 1.4);
cmd('0 G');
text('ENTRANCE', 5200, -900, 7);

// 寸法線（下）
const dimY = -2200;
line(0, dimY, 12000, dimY, 0.4);
for (const gx of [0, 6000, 12000]) line(gx, dimY - 300, gx, dimY + 300, 0.4);
text('6000', 2700, dimY + 300, 9);
text('6000', 8700, dimY + 300, 9);

// 寸法線（左）
const dimX = -2200;
line(dimX, 0, dimX, 8000, 0.4);
line(dimX - 300, 0, dimX + 300, 0, 0.4);
line(dimX - 300, 8000, dimX + 300, 8000, 0.4);
text('8000', dimX + 300, 3900, 9);

// 総寸法（上）
const topY = ROOM_H + 2000;
line(0, topY, 12000, topY, 0.4);
line(0, topY - 300, 0, topY + 300, 0.4);
line(12000, topY - 300, 12000, topY + 300, 0.4);
text('12000', 5300, topY + 300, 10);

// 図枠とタイトル
cmd(`0.8 w ${(15 * MM).toFixed(2)} ${(15 * MM).toFixed(2)} ${((420 - 30) * MM).toFixed(2)} ${((297 - 30) * MM).toFixed(2)} re S`);
textPt('SAMPLE OFFICE PLAN  1F', 20 * MM, 25 * MM, 14);
textPt('SCALE 1:50   A3   (sample drawing for layout-planner)', 20 * MM, 19 * MM, 9);

const content = out.join('\n');

/* ── PDFの組み立て ─────────────────────────────────── */

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W.toFixed(2)} ${PAGE_H.toFixed(2)}] `
    + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];

let pdf = '%PDF-1.4\n';
const offsets = [0];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefPos = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= objects.length; i += 1) {
  pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

const dest = path.join(__dirname, '..', 'docs', 'sample', 'sample-plan.pdf');
fs.writeFileSync(dest, pdf, 'latin1');
console.log(`wrote ${dest} (${pdf.length} bytes)`);
console.log('検算用: 通り芯間隔 6,000mm / 室内 12,000 × 8,000mm / 縮尺 1:50 / A3横');
