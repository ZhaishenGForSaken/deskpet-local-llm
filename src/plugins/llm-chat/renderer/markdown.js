/**
 * 对话窗口与小对话窗共用的渲染工具（纯函数，挂在全局）
 */

/** 轻量 Markdown 渲染（先转义，再处理代码块） */
function renderMarkdown(text) {
  if (!text) return '';
  const codeBlocks = [];
  let html = escapeHtml(text);

  html = html.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (match, code) => {
    const index = codeBlocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`) - 1;
    return `\u0000${index}\u0000`;
  });
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/\u0000(\d+)\u0000/g, (match, index) => codeBlocks[Number(index)] || '');
  return html;
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
