/**
 * 前台窗口探测（插件私有，仅依赖 Node 内置模块）
 *
 * Windows：常驻一个隐藏的 PowerShell 子进程，每隔 intervalMs 调用 user32 的
 *          GetForegroundWindow / GetWindowThreadProcessId 拿到前台程序名，按行输出 JSON。
 *          不需要编译原生模块；只有开启「读取窗口标题」时才会调用 GetWindowText。
 * macOS：  用 osascript 轮询最前台的应用名（不读标题）。
 * 其它平台：不支持，返回 null。
 *
 * 子进程会检查父进程是否还活着，DeskPet 异常退出时也不会残留。
 */

const { spawn, execFile } = require('child_process');

function windowsScript({ intervalMs, titles, parentPid }) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DeskPetForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
}
"@
while ($true) {
  if (-not (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue)) { exit }
  $hwnd = [DeskPetForeground]::GetForegroundWindow()
  $procId = [uint32]0
  [void][DeskPetForeground]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  $name = ''
  try { $name = [System.Diagnostics.Process]::GetProcessById([int]$procId).ProcessName } catch {}
  $title = ''
  ${titles ? `$sb = New-Object System.Text.StringBuilder 512
  [void][DeskPetForeground]::GetWindowText($hwnd, $sb, 512)
  $title = $sb.ToString()` : ''}
  [Console]::Out.WriteLine((@{ process = $name; title = $title } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${Math.max(500, Math.round(intervalMs))}
}
`;
}

/**
 * 启动前台窗口探测
 * @param {{ intervalMs?: number, titles?: boolean, onSample: (s: {process: string, title: string}) => void, onError?: (e: Error) => void }} options
 * @returns {{ stop: () => void } | null} 不支持的平台返回 null
 */
function startForegroundWatcher(options) {
  const intervalMs = Number(options.intervalMs) || 2000;
  const onSample = options.onSample;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};

  if (process.platform === 'win32') {
    const script = windowsScript({ intervalMs, titles: !!options.titles, parentPid: process.pid });
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          onSample({ process: String(parsed.process || ''), title: String(parsed.title || '') });
        } catch (e) { /* 忽略不完整的行 */ }
      }
    });
    child.on('error', onError);
    let stopped = false;
    child.on('exit', (code) => { if (!stopped) onError(new Error(`前台探测进程退出 (code ${code})`)); });
    return {
      stop() {
        stopped = true;
        try { child.kill(); } catch (e) { /* 忽略 */ }
      }
    };
  }

  if (process.platform === 'darwin') {
    let stopped = false;
    let timer = null;
    const poll = () => {
      execFile('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
        { timeout: 3000 }, (err, stdout) => {
          if (stopped) return;
          if (err) onError(err);
          else onSample({ process: String(stdout || '').trim(), title: '' });
          timer = setTimeout(poll, intervalMs);
        });
    };
    poll();
    return {
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
      }
    };
  }

  return null;
}

module.exports = { startForegroundWatcher };
