# Installs Brambit for the current user on Windows, no administrator needed.
# In PowerShell:
#
#   irm https://raw.githubusercontent.com/morethanrealio/Brambit/main/install.ps1 | iex
#
# Downloads its own Node.js (checksum pinned below, nothing else on the computer
# changes) and Brambit into %LOCALAPPDATA%\Programs\Brambit, installs the
# `brambit` command, the Start menu and desktop shortcuts and starting with
# Windows, then opens the setup page in the browser. Running it again updates
# Brambit. Your data stays in %USERPROFILE%\.brambit and survives updates.
#
# For tests: BRAMBIT_HOME (program folder), BRAMBIT_SOURCE (a local copy of this
# repository instead of the download) and BRAMBIT_NO_OPEN=1 (do not start it at the end).

# Everything inside a script block: under `iex` the settings below do not leak into
# the person's PowerShell, and an error stops the installer without closing the window.
& {
  $ErrorActionPreference = 'Stop'
  # Invoke-WebRequest is many times slower while it draws its progress bar.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $brambitVersion = '0.2.7'
  $nodeVersion = '24.21.0'
  # Node.js for Windows x64 (it also runs on Windows on ARM).
  $nodeSha = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'

  function Say($m) { Write-Host "[brambit] $m" }
  function Extract($zip, $to) {
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    # tar.exe (Windows 10 1803 and later) is much faster than Expand-Archive.
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $tar) { & $tar -xf $zip -C $to; if ($LASTEXITCODE) { throw "could not extract $zip" } }
    else { Expand-Archive -Path $zip -DestinationPath $to -Force }
    # Both archives have a single folder inside.
    return (Get-ChildItem -LiteralPath $to -Directory | Select-Object -First 1).FullName
  }

  if (-not [Environment]::Is64BitOperatingSystem) { throw 'Brambit needs 64-bit Windows' }
  $home_ = if ($env:BRAMBIT_HOME) { $env:BRAMBIT_HOME } else { Join-Path $env:LOCALAPPDATA 'Programs\Brambit' }
  New-Item -ItemType Directory -Force -Path $home_ | Out-Null
  $node = Join-Path $home_ 'node\node.exe'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('brambit-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null

  try {
    # An older copy running holds its files: stop it before replacing them.
    if ((Test-Path $node) -and (Test-Path (Join-Path $home_ 'app\installer\brambit.mjs'))) {
      & $node (Join-Path $home_ 'app\installer\brambit.mjs') stop | Out-Null
    }

    $current = if (Test-Path $node) { & $node --version } else { '' }
    if ($current -ne "v$nodeVersion") {
      Say "downloading Node.js $nodeVersion"
      $zip = Join-Path $tmp 'node.zip'
      Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -OutFile $zip
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ne $nodeSha) {
        throw 'the Node.js download does not match its checksum; nothing was installed'
      }
      $extracted = Extract $zip (Join-Path $tmp 'node')
      Remove-Item -Recurse -Force -LiteralPath (Join-Path $home_ 'node') -ErrorAction SilentlyContinue
      Move-Item -LiteralPath $extracted -Destination (Join-Path $home_ 'node')
    }

    $new = Join-Path $home_ 'app.new'
    Remove-Item -Recurse -Force -LiteralPath $new -ErrorAction SilentlyContinue
    if ($env:BRAMBIT_SOURCE) {
      Say "copying Brambit from $env:BRAMBIT_SOURCE"
      & robocopy $env:BRAMBIT_SOURCE $new /E /NFL /NDL /NJH /NJS /NP /XD node_modules .git .local | Out-Null
      # robocopy: 0 to 7 mean success.
      if ($LASTEXITCODE -ge 8) { throw "could not copy $env:BRAMBIT_SOURCE" }
    } else {
      Say "downloading Brambit $brambitVersion"
      $zip = Join-Path $tmp 'brambit.zip'
      Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/morethanrealio/Brambit/archive/refs/tags/v$brambitVersion.zip" -OutFile $zip
      $extracted = Extract $zip (Join-Path $tmp 'brambit')
      Move-Item -LiteralPath $extracted -Destination $new
    }

    Say 'installing what Brambit needs (this takes a few minutes)'
    $env:Path = (Join-Path $home_ 'node') + ';' + $env:Path
    $env:npm_config_update_notifier = 'false'
    Push-Location $new
    try { & (Join-Path $home_ 'node\npm.cmd') ci --no-audit --no-fund --loglevel=error } finally { Pop-Location }
    if ($LASTEXITCODE) { throw "npm could not install Brambit's packages; the copy already installed was kept" }

    $app = Join-Path $home_ 'app'
    Remove-Item -Recurse -Force -LiteralPath "$app.old" -ErrorAction SilentlyContinue
    if (Test-Path $app) { Rename-Item -LiteralPath $app -NewName 'app.old' }
    Rename-Item -LiteralPath $new -NewName 'app'
    Remove-Item -Recurse -Force -LiteralPath "$app.old" -ErrorAction SilentlyContinue
    Set-Content -LiteralPath (Join-Path $home_ '.brambit-install') -Value $brambitVersion

    & $node (Join-Path $app 'installer\desktop.mjs') install
    if ($LASTEXITCODE) { throw 'could not create the shortcuts' }
    Say "installed in $home_"
    Say 'Brambit is in the Start menu and on the desktop, and starts with Windows'
    if (-not $env:BRAMBIT_NO_OPEN) { & $node (Join-Path $app 'installer\brambit.mjs') open }
  } finally {
    Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
  }
}
