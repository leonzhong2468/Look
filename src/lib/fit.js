// ============================================================
//  白底主图归一化：豆包出图后主体常常偏小、四周留白过多
//  这里用本地像素处理把主体裁出来，再按固定比例重新排版到纯白画布
//  纯 Electron 实现（nativeImage），不依赖任何外部库
// ============================================================
const fs = require('fs');
const { nativeImage } = require('electron');

const WHITE = 246; // 判定「接近白」的阈值

function inspect(img) {
  const { width: W, height: H } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  let minx = W, miny = H, maxx = -1, maxy = -1, count = 0;
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      const i = row + x * 4;
      const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2], a = bmp[i + 3];
      if (a > 10 && (r < WHITE || g < WHITE || b < WHITE)) {
        count++;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
  }
  const bbox = maxx < 0 ? null : { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 };
  return { W, H, bmp, bbox, count };
}

function cornerWhite(bmp, W, H, pad = 6) {
  const pts = [[pad, pad], [W - 1 - pad, pad], [pad, H - 1 - pad], [W - 1 - pad, H - 1 - pad]];
  let ok = 0;
  for (const [x, y] of pts) {
    const i = (y * W + x) * 4;
    const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
    if (r >= WHITE && g >= WHITE && b >= WHITE) ok++;
  }
  return ok >= 3; // 至少 3 个角是白的，才认为这是白底图
}

/**
 * 把主体归一化到 target 比例（长边占画布比例）
 * @returns {{ok:boolean, err?:string, before?:number, after?:number, size?:number}}
 */
function normalizeWhite(srcPath, outPath, opts = {}) {
  const target = opts.target || 0.86;
  const minSide = opts.minSide || 2000;
  const img = nativeImage.createFromPath(srcPath);
  if (img.isEmpty()) return { ok: false, err: '图片读不出来' };

  const { W, H, bmp, bbox } = inspect(img);
  if (!bbox) return { ok: false, err: '整图接近纯白，没找到主体' };
  if (!cornerWhite(bmp, W, H)) return { ok: false, err: '不是白底图，跳过归一化' };

  const before = Math.max(bbox.w / W, bbox.h / H);
  if (before >= target - 0.04) {
    return { ok: true, skipped: true, before, after: before, size: W };
  }

  // 目标画布：主体长边 = target * 画布边长
  const longSide = Math.max(bbox.w, bbox.h);
  let canvas = Math.round(longSide / target);
  canvas = Math.max(canvas, 600);

  const out = Buffer.alloc(canvas * canvas * 4, 255); // 纯白不透明
  const ox = Math.round((canvas - bbox.w) / 2);
  const oy = Math.round((canvas - bbox.h) / 2 - canvas * 0.015); // 略微上移，视觉更稳
  const oySafe = Math.max(0, Math.min(canvas - bbox.h, oy));

  for (let y = 0; y < bbox.h; y++) {
    const sy = bbox.y + y;
    if (sy < 0 || sy >= H) continue;
    const srcStart = (sy * W + bbox.x) * 4;
    const dstStart = ((oySafe + y) * canvas + ox) * 4;
    bmp.copy(out, dstStart, srcStart, srcStart + bbox.w * 4);
  }

  let ni = nativeImage.createFromBitmap(out, { width: canvas, height: canvas });
  if (canvas < minSide) {
    ni = ni.resize({ width: minSide, height: minSide, quality: 'best' });
  }
  const buf = ni.toPNG();
  fs.writeFileSync(outPath, buf);

  const after = longSide / canvas;
  return { ok: true, before, after, size: Math.max(minSide, canvas), bytes: buf.length };
}

module.exports = { normalizeWhite };
