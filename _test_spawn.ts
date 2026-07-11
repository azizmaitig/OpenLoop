import { platform } from 'node:os';

function isWindows(): boolean {
  return platform() === 'win32';
}

async function main() {
  const cmd = 'npm --prefix "D:\\projects\\obsidian\\second brain\\10-Projects\\11-Active\\calendar-app" run build';
  const args = isWindows() ? ['cmd.exe', '/c', cmd] : ['/bin/sh', '-c', cmd];
  console.log('Spawning:', JSON.stringify(args));

  const proc = Bun.spawn(args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const [stdout, stderr] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ]);
  const exitCode = await proc.exited;
  console.log('exitCode:', exitCode);
  console.log('stdout:', stdout);
  console.log('stderr:', stderr);
}

main().catch(console.error);
