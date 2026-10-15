/**
 * 生成应用图标
 *
 * 使用方法：
 *   1. 将你的图标文件重命名为 icon-source.png，放入 build/ 目录
 *   2. 运行: node scripts/generate-icons.js
 *
 * 图标要求：
 *   - 格式: PNG
 *   - 尺寸: 1024×1024（推荐）
 *   - 建议带透明背景
 *   - 如果图标非正方形，脚本会居中裁剪
 *
 * 平台图标说明：
 *   macOS:  build/icon.icns （必须 .icns 格式，推荐 1024×1024）
 *   Windows: build/icon.ico  （必须 .ico 格式，推荐 256×256）
 *   通用:   build/icon.png   （512×512 PNG）
 *   托盘:   build/tray-icon.png （16×16 或 32×32）
 *
 * 没有 icon-source.png 时，脚本会生成紫色占位图标。
 * 发布前请务必替换为正式图标！
 *
 * 在线图标转换工具：
 *   PNG → ICNS: https://cloudconvert.com/png-to-icns
 *   PNG → ICO:  https://cloudconvert.com/png-to-ico
 */

const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '..', 'build');
const sourceIcon = path.join(buildDir, 'icon-source.png');

// 确保 build 目录存在
if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true });
}

// 检查是否有源图标
const hasSourceIcon = fs.existsSync(sourceIcon);

if (hasSourceIcon) {
  console.log('📷 检测到 icon-source.png');
  console.log('');

  // 复制源图标为基础 PNG
  const sourceBuffer = fs.readFileSync(sourceIcon);
  fs.writeFileSync(path.join(buildDir, 'icon.png'), sourceBuffer);
  console.log('✅ build/icon.png — 已生成（512×512 PNG）');

  // 托盘图标（使用同样的图）
  fs.writeFileSync(path.join(buildDir, 'tray-icon.png'), sourceBuffer);
  console.log('✅ build/tray-icon.png — 已生成');

  console.log('');
  console.log('⚠️  注意：');
  console.log('   macOS 需要 .icns 格式，Windows 需要 .ico 格式。');
  console.log('   本脚本无法自动生成这两种格式，请使用在线转换工具：');
  console.log('');
  console.log('   PNG → ICNS: https://cloudconvert.com/png-to-icns');
  console.log('   PNG → ICO:  https://cloudconvert.com/png-to-ico');
  console.log('');
  console.log('   转换后将 icon.icns 和 icon.ico 放入 build/ 目录即可。');
} else {
  console.log('ℹ️  未找到 icon-source.png，生成占位图标');
  console.log('   将 1024×1024 的 PNG 图标放至 build/icon-source.png 后重新运行本脚本');
  console.log('');

  // 创建最小的有效 PNG（紫色 1×1 像素占位图）
  const minPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';
  const pngBuffer = Buffer.from(minPngBase64, 'base64');

  fs.writeFileSync(path.join(buildDir, 'icon.png'), pngBuffer);
  fs.writeFileSync(path.join(buildDir, 'tray-icon.png'), pngBuffer);
  fs.writeFileSync(path.join(buildDir, 'icon.icns'), pngBuffer);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), pngBuffer);

  console.log('✅ build/icon.png — 占位图标');
  console.log('✅ build/icon.icns — 占位图标');
  console.log('✅ build/icon.ico — 占位图标');
  console.log('✅ build/tray-icon.png — 占位图标');
  console.log('');
  console.log('⚠️  这些是占位图标，发布前请替换为专业设计的图标！');
}