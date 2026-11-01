// windows-orphans: on Windows, stopping a background task ends its shell but not the node process
// that npx/pnpm started, which keeps its port. After TaskStop, name any listening node.exe whose
// parent is gone, so the session ends it now instead of hitting EADDRINUSE later.
import { execFileSync } from 'node:child_process';

export default function afterStop(input) {
  if (process.platform !== 'win32') return null;
  if (!/^(TaskStop|KillShell|KillBash)$/.test(input.tool_name)) return null;
  const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  const procs = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 12000, windowsHide: true }));
  const alive = new Set(procs.map((p) => p.ProcessId));
  const ports = new Map();
  for (const l of execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).split('\n')) {
    const m = l.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (m) ports.set(+m[2], [...(ports.get(+m[2]) || []), m[1]]);
  }
  const orphans = procs.filter((p) => /^node(\.exe)?$/i.test(p.Name) && ports.has(p.ProcessId) && !alive.has(p.ParentProcessId));
  if (!orphans.length) return null;
  const list = orphans.map((p) => `  pid ${p.ProcessId}, port ${[...new Set(ports.get(p.ProcessId))].join('/')}: ${(p.CommandLine || '').slice(0, 160)}`).join('\n');
  return (
    'TaskStop on Windows leaves the node process that npx/pnpm started still running. These node processes are listening and their parent is gone:\n' +
    list +
    '\nIf one is the server you just stopped, end it with PowerShell `Stop-Process -Id <pid> -Force`. Leave any you did not start.'
  );
}
