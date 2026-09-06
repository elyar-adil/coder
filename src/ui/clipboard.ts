import { spawn } from 'node:child_process';

/** Clipboard payload travels over stdin, never through shell interpolation. */
export function copyText(text: string): Promise<void> {
  const command = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? 'pbcopy' : process.env.WAYLAND_DISPLAY ? 'wl-copy' : 'xclip';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); Set-Clipboard -Value ([Console]::In.ReadToEnd())']
    : command === 'xclip' ? ['-selection', 'clipboard'] : [];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Clipboard operation timed out')); }, 5000);
    child.stderr.on('data', (chunk) => { error += chunk.toString(); });
    child.on('error', (cause) => { clearTimeout(timer); reject(cause); });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error(error.trim() || 'Clipboard unavailable'));
    });
    child.stdin.end(text, 'utf8');
  });
}
