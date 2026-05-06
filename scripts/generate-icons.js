/**
 * 图标生成脚本
 *
 * 将 media/marketplace-source.svg 渲染为市场用 PNG (128x128 + 256x256)
 * 仅开发态使用, 在 npm run package 前运行一次
 *
 * 使用:
 *   node scripts/generate-icons.js
 *
 * 依赖: sharp (npm i -D sharp)
 *
 * 开发者: Ti
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SVG_SRC = path.join(ROOT, 'media', 'marketplace-source.svg');
const PNG_OUT_128 = path.join(ROOT, 'media', 'marketplace.png');
const PNG_OUT_256 = path.join(ROOT, 'media', 'marketplace@2x.png');

async function main() {
  if (!fs.existsSync(SVG_SRC)) {
    console.error('未找到源 SVG:', SVG_SRC);
    process.exit(1);
  }

  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.error('请先安装 sharp:  npm install --save-dev sharp');
    process.exit(1);
  }

  const svgBuffer = fs.readFileSync(SVG_SRC);

  /* 128x128 (市场最低要求) */
  await sharp(svgBuffer, { density: 300 })
    .resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(PNG_OUT_128);
  const size128 = fs.statSync(PNG_OUT_128).size;
  console.log('[OK]', path.relative(ROOT, PNG_OUT_128), '(' + size128 + ' B)');

  /* 256x256 (Retina) */
  await sharp(svgBuffer, { density: 400 })
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(PNG_OUT_256);
  const size256 = fs.statSync(PNG_OUT_256).size;
  console.log('[OK]', path.relative(ROOT, PNG_OUT_256), '(' + size256 + ' B)');
}

main().catch(err => {
  console.error('生成失败:', err);
  process.exit(1);
});
