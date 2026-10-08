// Puts an installed Brambit on the computer: the `brambit` command, the shortcut
// that opens it (Start menu and desktop on Windows, Applications on macOS, the
// app menu on Linux) and starting with the computer. install.ps1 / install.sh run
// `install` after the download; `brambit uninstall` runs `uninstall`.
//
// The installed layout is <home>/node (its own Node.js), <home>/app (this
// repository) and <home>/.brambit-install (the marker the scripts write). Without
// the marker nothing here runs, so a git clone is never touched.
//
// Usage: node installer/desktop.mjs install | uninstall
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const home = path.dirname(app);
export const installed = () => existsSync(path.join(home, '.brambit-install')) && path.basename(app) === 'app';
const launcher = path.join(app, 'installer', 'brambit.mjs');
const node = process.execPath;
const assets = path.join(app, 'installer', 'assets');
const PATH_MARK = '# Added by the Brambit installer';
const LABEL = 'io.github.morethanrealio.brambit';

// Runs a PowerShell script with values passed as environment variables (no quoting).
function powershell(script, env) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
}

const WIN_SHORTCUTS = `
# Its progress bar comes out as CLIXML noise when the output is not a console.
$ProgressPreference = 'SilentlyContinue'
$shell = New-Object -ComObject WScript.Shell
$programs = Join-Path ([Environment]::GetFolderPath('Programs')) 'Brambit.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Brambit.lnk'
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Brambit.lnk'
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @(if ($path) { $path.Split(';') | Where-Object { $_ -and $_ -ne $env:B_BIN } })
if ($env:B_ACTION -eq 'install') {
  foreach ($l in @(@($programs, 'open'), @($desktop, 'open'), @($startup, 'open --no-browser'))) {
    $s = $shell.CreateShortcut($l[0])
    $s.TargetPath = $env:B_NODE
    $s.Arguments = '"' + $env:B_LAUNCHER + '" ' + $l[1]
    $s.WorkingDirectory = $env:B_HOME
    $s.IconLocation = $env:B_ICON
    $s.Description = 'Brambit'
    $s.WindowStyle = 7
    $s.Save()
  }
  $parts += $env:B_BIN
} else {
  foreach ($l in @($programs, $desktop, $startup)) { Remove-Item -LiteralPath $l -Force -ErrorAction SilentlyContinue }
}
[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
`;

// Unix: ~/.local/bin on the PATH of new terminals, when it is not there yet.
function rcFiles() {
  const h = os.homedir();
  const files = [path.join(h, '.zshrc'), path.join(h, '.bashrc')];
  return process.platform === 'darwin' ? files : files.filter((f) => existsSync(f));
}
function addToPath(dir) {
  if (String(process.env.PATH || '').split(path.delimiter).includes(dir)) return;
  for (const f of rcFiles()) {
    const text = existsSync(f) ? readFileSync(f, 'utf8') : '';
    if (!text.includes(PATH_MARK)) writeFileSync(f, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${PATH_MARK}\nexport PATH="${dir}:$PATH"\n`);
  }
}
function removeFromPath() {
  for (const f of rcFiles()) {
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf8');
    const kept = text.replace(new RegExp(`${PATH_MARK}\\n[^\\n]*\\n?`, 'g'), '');
    if (kept !== text) writeFileSync(f, kept);
  }
}

// Every file this installs outside <home>, per system.
function places() {
  const h = os.homedir();
  const localBin = path.join(h, '.local', 'bin');
  if (process.platform === 'darwin') {
    return { localBin, appBundle: path.join(h, 'Applications', 'Brambit.app'), agent: path.join(h, 'Library', 'LaunchAgents', `${LABEL}.plist`) };
  }
  const data = process.env.XDG_DATA_HOME || path.join(h, '.local', 'share');
  const config = process.env.XDG_CONFIG_HOME || path.join(h, '.config');
  return { localBin, menu: path.join(data, 'applications', 'brambit.desktop'), autostart: path.join(config, 'autostart', 'brambit.desktop') };
}

const plist = (dict) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${dict}
</dict>
</plist>
`;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Desktop entry Exec field: quoted arguments, with ", `, $ and \ escaped.
const execArg = (s) => `"${String(s).replace(/[\\"`$]/g, (c) => `\\${c}`)}"`;
const desktopEntry = (args, extra = '') => `[Desktop Entry]
Type=Application
Name=Brambit
Comment=Your assistant, on this computer
Exec=${execArg(node)} ${execArg(launcher)} ${args}
Icon=${path.join(home, 'brambit.png')}
Terminal=false
Categories=Office;
${extra}`;

export function install() {
  if (!installed()) throw new Error('not an installed copy (run install.ps1 or install.sh)');
  const bin = path.join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    copyFileSync(path.join(assets, 'brambit.ico'), path.join(home, 'brambit.ico'));
    writeFileSync(path.join(bin, 'brambit.cmd'), `@"${node}" "${launcher}" %*\r\n`);
    powershell(WIN_SHORTCUTS, { B_ACTION: 'install', B_NODE: node, B_LAUNCHER: launcher, B_HOME: home, B_ICON: path.join(home, 'brambit.ico'), B_BIN: bin });
    return;
  }
  const command = path.join(bin, 'brambit');
  writeFileSync(command, `#!/bin/sh\nexec ${sh(node)} ${sh(launcher)} "$@"\n`, { mode: 0o755 });
  const p = places();
  mkdirSync(p.localBin, { recursive: true });
  rmSync(path.join(p.localBin, 'brambit'), { force: true });
  symlinkSync(command, path.join(p.localBin, 'brambit'));
  addToPath(p.localBin);
  if (process.platform === 'darwin') {
    // A minimal app bundle made on this computer (not downloaded, so macOS does not
    // quarantine it): Launchpad, Spotlight and the Dock find it in ~/Applications.
    rmSync(p.appBundle, { recursive: true, force: true });
    mkdirSync(path.join(p.appBundle, 'Contents', 'MacOS'), { recursive: true });
    mkdirSync(path.join(p.appBundle, 'Contents', 'Resources'), { recursive: true });
    copyFileSync(path.join(assets, 'brambit.icns'), path.join(p.appBundle, 'Contents', 'Resources', 'brambit.icns'));
    writeFileSync(path.join(p.appBundle, 'Contents', 'MacOS', 'brambit'), `#!/bin/sh\nexec ${sh(node)} ${sh(launcher)} open\n`, { mode: 0o755 });
    writeFileSync(path.join(p.appBundle, 'Contents', 'Info.plist'), plist(`  <key>CFBundleName</key><string>Brambit</string>
  <key>CFBundleIdentifier</key><string>${LABEL}</string>
  <key>CFBundleExecutable</key><string>brambit</string>
  <key>CFBundleIconFile</key><string>brambit</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>`));
    // Starts at login. AbandonProcessGroup: `open` leaves Brambit running and exits.
    mkdirSync(path.dirname(p.agent), { recursive: true });
    writeFileSync(p.agent, plist(`  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(launcher)}</string><string>open</string><string>--no-browser</string></array>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>`));
    return;
  }
  copyFileSync(path.join(assets, 'brambit.png'), path.join(home, 'brambit.png'));
  mkdirSync(path.dirname(p.menu), { recursive: true });
  writeFileSync(p.menu, desktopEntry('open'));
  mkdirSync(path.dirname(p.autostart), { recursive: true });
  writeFileSync(p.autostart, desktopEntry('open --no-browser', 'X-GNOME-Autostart-enabled=true\n'));
}

export function uninstall() {
  if (!installed()) throw new Error('not an installed copy');
  if (process.platform === 'win32') {
    powershell(WIN_SHORTCUTS, { B_ACTION: 'uninstall', B_BIN: path.join(home, 'bin') });
    return;
  }
  const p = places();
  try { if (readFileSync(path.join(p.localBin, 'brambit'), 'utf8').includes(launcher)) unlinkSync(path.join(p.localBin, 'brambit')); } catch {}
  removeFromPath();
  if (process.platform === 'darwin') {
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' }); } catch {}
    rmSync(p.appBundle, { recursive: true, force: true });
    rmSync(p.agent, { force: true });
    return;
  }
  rmSync(p.menu, { force: true });
  rmSync(p.autostart, { force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  try {
    if (command === 'install') install();
    else if (command === 'uninstall') uninstall();
    else { console.error('usage: node installer/desktop.mjs install | uninstall'); process.exitCode = 2; }
  } catch (e) { console.error(`[brambit] ${e.message}`); process.exitCode = 1; }
}
