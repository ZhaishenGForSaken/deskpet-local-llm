/**
 * 前台窗口探测（插件私有，仅依赖 Node 内置模块）
 *
 * Windows：常驻一个隐藏的 PowerShell 子进程，每隔 intervalMs 调用 user32 的
 *          GetForegroundWindow / GetWindowThreadProcessId 拿到前台程序名，按行输出 JSON。
 *          不需要编译原生模块；只有开启「读取窗口标题」时才会调用 GetWindowText。
 *          开启 audio 时还会通过系统音频会话（与音量合成器同源）读取「正在出声的程序名」，
 *          用来识别后台播放的音乐；只拿程序名，不读歌名。
 * macOS：  用 osascript 轮询最前台的应用名（不读标题）。
 * 其它平台：不支持，返回 null。
 *
 * 子进程会检查父进程是否还活着，DeskPet 异常退出时也不会残留。
 */

const { spawn, execFile } = require('child_process');

const AUDIO_CS = `
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
}
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
  [PreserveSig] int GetAudioSessionControl(IntPtr groupingParam, int flags, out IntPtr control);
  [PreserveSig] int GetSimpleAudioVolume(IntPtr groupingParam, int flags, out IntPtr volume);
  [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
}
[ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName(out IntPtr name);
  [PreserveSig] int SetDisplayName(IntPtr name, IntPtr context);
  [PreserveSig] int GetIconPath(out IntPtr path);
  [PreserveSig] int SetIconPath(IntPtr path, IntPtr context);
  [PreserveSig] int GetGroupingParam(out Guid param);
  [PreserveSig] int SetGroupingParam(IntPtr param, IntPtr context);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
  [PreserveSig] int GetSessionIdentifier(out IntPtr id);
  [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
  [PreserveSig] int GetProcessId(out uint pid);
}
[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation {
  [PreserveSig] int GetPeakValue(out float peak);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorCom {}
public static class DeskPetAudio {
  // 默认输出设备上「真的在出声」的程序名（会话活跃且峰值电平大于 0），用 | 分隔
  public static string SoundingPrograms() {
    var names = new System.Collections.Generic.List<string>();
    try {
      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
      IMMDevice device;
      if (enumerator.GetDefaultAudioEndpoint(0, 1, out device) != 0) return "";
      Guid iid = typeof(IAudioSessionManager2).GUID;
      object instance;
      if (device.Activate(ref iid, 23, IntPtr.Zero, out instance) != 0) return "";
      IAudioSessionEnumerator sessions;
      if (((IAudioSessionManager2)instance).GetSessionEnumerator(out sessions) != 0) return "";
      int count; sessions.GetCount(out count);
      for (int i = 0; i < count; i++) {
        IAudioSessionControl2 session;
        if (sessions.GetSession(i, out session) != 0 || session == null) continue;
        int state; session.GetState(out state);
        uint pid; session.GetProcessId(out pid);
        float peak = 0;
        var meter = session as IAudioMeterInformation;
        if (meter != null) meter.GetPeakValue(out peak);
        if (state == 1 && pid != 0 && peak > 0.0005f) {
          try {
            var name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
            if (!names.Contains(name)) names.Add(name);
          } catch {}
        }
        Marshal.ReleaseComObject(session);
      }
    } catch {}
    return string.Join("|", names);
  }
}`;

function windowsScript({ intervalMs, titles, audio, parentPid }) {
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
${audio ? AUDIO_CS : ''}
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
  $audio = ''
  ${audio ? '$audio = [DeskPetAudio]::SoundingPrograms()' : ''}
  [Console]::Out.WriteLine((@{ process = $name; title = $title; audio = $audio } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${Math.max(500, Math.round(intervalMs))}
}
`;
}

/**
 * 启动前台窗口探测
 * @param {{ intervalMs?: number, titles?: boolean, audio?: boolean,
 *   onSample: (s: {process: string, title: string, audio: string[]}) => void, onError?: (e: Error) => void }} options
 * @returns {{ stop: () => void } | null} 不支持的平台返回 null
 */
function startForegroundWatcher(options) {
  const intervalMs = Number(options.intervalMs) || 2000;
  const onSample = options.onSample;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};

  if (process.platform === 'win32') {
    const script = windowsScript({ intervalMs, titles: !!options.titles, audio: !!options.audio, parentPid: process.pid });
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
          onSample({
            process: String(parsed.process || ''),
            title: String(parsed.title || ''),
            audio: String(parsed.audio || '').split('|').map((s) => s.trim()).filter(Boolean)
          });
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
          else onSample({ process: String(stdout || '').trim(), title: '', audio: [] });
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
