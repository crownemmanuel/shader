$ErrorActionPreference = 'Stop'
$version = '1.28.8'
$installer = Join-Path $env:RUNNER_TEMP "gstreamer-$version.exe"
$root = Join-Path $env:RUNNER_TEMP 'gstreamer'
$url = "https://gstreamer.freedesktop.org/data/pkg/windows/$version/msvc/gstreamer-1.0-msvc-x86_64-$version.exe"
Invoke-WebRequest $url -OutFile $installer
$expected = 'e4c41ee6ee9c6c32a45d198463ec08d79bac3bd5fa58adc93d13fe4a08abc9d9'
if ((Get-FileHash $installer -Algorithm SHA256).Hash.ToLower() -ne $expected) {
  throw 'GStreamer installer checksum mismatch'
}
$install = Start-Process -FilePath $installer -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', '/TYPE=devel', "/DIR=`"$root`"") -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "GStreamer installer exited $($install.ExitCode)" }
if (-not (Test-Path "$root\lib\pkgconfig\gstreamer-1.0.pc")) { throw 'GStreamer development package missing' }
"GSTREAMER_1_0_ROOT_MSVC_X86_64=$root" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"PKG_CONFIG_PATH=$root\lib\pkgconfig" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"$root\bin" | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
