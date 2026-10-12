import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * 调用系统原生「选择文件夹」对话框，拿到本机绝对路径。
 * 只有本机（loopback）能调用——见 routes.js 的 requireLocal。
 */
function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 120000 }, (err, stdout) => {
      if (err) return resolve({ error: err });
      return resolve({ path: String(stdout).trim() });
    });
  });
}

export async function pickFolder() {
  const platform = process.platform;
  if (platform === 'darwin') {
    const out = await run('/usr/bin/osascript', [
      '-e',
      'on run argv\n  return POSIX path of (choose folder with prompt "选择要挂载的素材目录")\nend run',
    ]);
    if (out.path) return { path: out.path };
    // 用户按了「取消」不算错误
    if (/-128/.test(out.error?.message ?? '')) return { cancelled: true };
    return { error: '没能打开系统文件夹选择器，请直接粘贴路径' };
  }
  if (platform === 'win32') {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.FolderBrowserDialog;" +
      'if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){$d.SelectedPath}';
    const out = await run('powershell', ['-NoProfile', '-Command', script]);
    return out.path ? { path: out.path } : { cancelled: true };
  }
  const zenity = await run('zenity', ['--file-selection', '--directory', '--title=选择要挂载的素材目录']);
  if (zenity.path) return { path: zenity.path };
  const kdialog = await run('kdialog', ['--getexistingdirectory', process.env.HOME ?? '.']);
  if (kdialog.path) return { path: kdialog.path.trim() };
  return { error: '这台机器上没有可用的文件夹选择器，请直接粘贴路径' };
}

export function normalizePicked(input) {
  const value = String(input ?? '').trim().replace(/^["']+|["']+$/g, '');
  return value ? path.resolve(value) : '';
}
