/**
 * 生成默认动画素材的脚本
 * 在没有实际 webm 文件时，应用将使用 Canvas 绘制的占位动画
 *
 * 如需添加自定义动画，请将 .webm 文件放入以下目录：
 *   - assets/animations/idle/   (闲置动画)
 *   - assets/animations/click/  (点击反应动画)
 *
 * 推荐使用支持透明通道的 WebM 格式（VP8/VP9 + Alpha）
 * 推荐工具：Adobe After Effects、Blender、FFmpeg
 *
 * 使用 FFmpeg 转换示例：
 *   ffmpeg -i input.mov -c:v vp9 -pix_fmt yuva420p output.webm
 */

const fs = require('fs');
const path = require('path');

// 确保动画目录存在
const idleDir = path.join(__dirname, '..', 'assets', 'animations', 'idle');
const clickDir = path.join(__dirname, '..', 'assets', 'animations', 'click');
const buildDir = path.join(__dirname, '..', 'build');

[idleDir, clickDir, buildDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// 创建占位文件说明
const readmeContent = `# 动画素材目录

请将 .webm 格式的动画文件放入对应目录：

## 闲置动画 (idle/)
桌宠空闲时随机播放的动画，建议 3-5 秒循环视频。

## 点击反应动画 (click/)
点击桌宠时播放的反应动画，建议 1-3 秒单次播放。

## 格式要求
- 格式: WebM (VP8/VP9 编码)
- 建议启用透明通道 (Alpha)
- 分辨率: 建议 512x512 以内
- 大小: 每个文件建议 < 5MB

## 获取动画素材
- 自行制作：使用 After Effects、Blender 等工具
- 在线资源：搜索 "animated pet webm" 或 "live2d webm"
- 社区分享：加入我们的社区获取更多素材
`;

fs.writeFileSync(path.join(idleDir, 'README.md'), readmeContent);
fs.writeFileSync(path.join(clickDir, 'README.md'), readmeContent);

console.log('✅ 动画素材目录已就绪');
console.log(`  闲置动画: ${idleDir}`);
console.log(`  点击动画: ${clickDir}`);
console.log('');
console.log('💡 提示: 应用内置了 Canvas 占位动画，无需 .webm 文件也能运行');
console.log('   添加 .webm 文件后将自动使用真实动画素材');