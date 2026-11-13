// The icon in the Windows notification area: open the dashboard, show the log,
// quit, and notifications. A small PowerShell script draws it, so there's nothing
// extra to install. The script asks the server to quit over stdout; the server
// sends notifications as JSON lines on stdin, and closes stdin when it stops,
// and the script then removes its icon.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const SCRIPT = String.raw`
param([int]$ServerPid, [string]$Url, [string]$Log, [switch]$Intro)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$server = [System.Diagnostics.Process]::GetProcessById($ServerPid)
# stdin carries notifications until the server stops (read on a pool thread so the menu stays responsive)
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
$script:pending = $stdin.ReadLineAsync()
$script:notifyUrl = $Url

# stdout is how we talk to the server, so nothing else may be written to it
function Send([string]$message) {
  [Console]::Out.WriteLine($message)
  [Console]::Out.Flush()
}

function Get-Setting([string]$key, [string]$name, $fallback) {
  try { return Get-ItemPropertyValue -Path $key -Name $name } catch { return $fallback }
}

function Test-LightTaskbar {
  return (Get-Setting 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' 'SystemUsesLightTheme' 0) -eq 1
}

function New-RoundedStrip([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# The Handoff mark (two strips, one handed across), drawn at the tray's size so it stays sharp
function New-MarkIcon([bool]$light) {
  $dpi = [int](Get-Setting 'HKCU:\Control Panel\Desktop\WindowMetrics' 'AppliedDPI' 96)
  $size = [int][Math]::Max(16, [Math]::Round(16 * $dpi / 96))
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  # the logo's 32-unit box, cropped to 2..30 so the strips fill the icon
  $s = $size / 28
  $inkColor = if ($light) { '#18201C' } else { '#E7ECE8' }
  $ink = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($inkColor))
  $signal = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#F2C230'))
  $g.FillPath($ink, (New-RoundedStrip (1 * $s) (5 * $s) (19 * $s) (7 * $s) (2 * $s)))
  $g.FillPath($signal, (New-RoundedStrip (8 * $s) (16 * $s) (19 * $s) (7 * $s) (2 * $s)))
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$script:light = Test-LightTaskbar
$script:lastOpen = [DateTime]::MinValue

function Open-Dashboard {
  # one click is enough; ignore the second half of a double-click
  if (([DateTime]::Now - $script:lastOpen).TotalSeconds -lt 1.5) { return }
  $script:lastOpen = [DateTime]::Now
  Start-Process $Url
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = New-MarkIcon $script:light
$tray.Text = "Claude Handoff" + [char]10 + $Url

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open dashboard')
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
$open.add_Click({ $script:lastOpen = [DateTime]::MinValue; Open-Dashboard })
if ($Log) {
  $showLog = $menu.Items.Add('Show log')
  $showLog.add_Click({ if (Test-Path $Log) { Start-Process notepad.exe -ArgumentList ('"' + $Log + '"') } })
}
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quit = $menu.Items.Add('Quit Claude Handoff')
$quit.add_Click({
  $tray.Text = 'Claude Handoff is stopping'
  Send 'quit'
})
$tray.ContextMenuStrip = $menu
$tray.add_BalloonTipClicked({ Start-Process $script:notifyUrl })
$tray.add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Dashboard }
})
$tray.Visible = $true
if ($Intro) {
  $tray.ShowBalloonTip(8000, 'Claude Handoff is running', 'It lives here now. Click to open the dashboard, right-click to quit.', [System.Windows.Forms.ToolTipIcon]::None)
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
function Show-Notification([string]$line) {
  try {
    $n = $line | ConvertFrom-Json
    $script:notifyUrl = $n.url
    $tray.ShowBalloonTip(10000, $n.title, $n.body, [System.Windows.Forms.ToolTipIcon]::None)
  } catch { [Console]::Error.WriteLine("bad notification: $_") }
}

function Test-ServerGone {
  if ($server.HasExited) { return $true }
  while ($script:pending.IsCompleted) {
    if ($script:pending.IsFaulted -or $null -eq $script:pending.Result) { return $true }
    if ($script:pending.Result.Trim()) { Show-Notification $script:pending.Result }
    $script:pending = $stdin.ReadLineAsync()
  }
  return $false
}

$timer.add_Tick({
  if (Test-ServerGone) {
    $timer.Stop()
    $tray.Visible = $false
    $tray.Dispose()
    [System.Windows.Forms.Application]::Exit()
    return
  }
  $now = Test-LightTaskbar
  if ($now -ne $script:light) {
    $script:light = $now
    $tray.Icon = New-MarkIcon $now
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
`;

export interface TrayOptions {
  dataDir: string;
  url: string;
  /** The log file, when Handoff runs in the background. */
  log?: string;
  onQuit: () => void;
}

export interface Tray {
  /** Show a Windows notification; clicking it opens `url`. */
  notify(title: string, body: string, url: string): void;
  /** Remove the icon; resolves once it's gone (or after a second). */
  stop(): Promise<void>;
}

/** Show the tray icon (Windows only). Never throws: Handoff works fine without it. */
export function startTray(opts: TrayOptions): Tray | null {
  if (process.platform !== 'win32') return null;
  try {
    const script = path.join(opts.dataDir, 'tray.ps1');
    if (!fs.existsSync(script) || fs.readFileSync(script, 'utf8') !== SCRIPT) fs.writeFileSync(script, SCRIPT);
    // the first time, a balloon points out where Handoff went
    const introMarker = path.join(opts.dataDir, 'tray-intro-shown');
    const intro = !!opts.log && !fs.existsSync(introMarker);
    if (intro) fs.writeFileSync(introMarker, new Date().toISOString());

    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-ServerPid', String(process.pid), '-Url', opts.url];
    if (opts.log) args.push('-Log', opts.log);
    if (intro) args.push('-Intro');
    // Not detached: PowerShell won't run without a console. It goes down with us,
    // so stop() has to come first or Windows keeps showing a dead icon until you hover it.
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', (e) => console.error('[handoff] tray icon unavailable:', e.message));
    child.stdin!.on('error', () => void 0);
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      if (line.trim() === 'quit') opts.onQuit();
    });
    readline.createInterface({ input: child.stderr! }).on('line', (line) => {
      if (line.trim()) console.error('[tray]', line);
    });
    child.unref();
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    return {
      // Windows caps balloon titles at 63 characters and text at 255
      notify: (title, body, url) => {
        if (child.stdin!.writable) child.stdin!.write(JSON.stringify({ title: title.slice(0, 63), body: body.slice(0, 255), url }) + '\n');
      },
      stop: () => {
        child.stdin!.end();
        return Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
      },
    };
  } catch (e: any) {
    console.error('[handoff] tray icon unavailable:', e?.message ?? e);
    return null;
  }
}
