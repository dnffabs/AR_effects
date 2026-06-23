# =============================================================
#  Dual-Hand AR Dimensional Rift - Local HTTP Server
#  Auto-finds a free port / opens the default browser / serves files
#  (Camera API requires http://localhost, file:// will not work)
#
#  NOTE: This script is intentionally ASCII-only. Windows PowerShell 5.1
#  reads .ps1 files without a BOM using the system ANSI code page, so
#  non-ASCII characters in string literals can corrupt parsing.
# =============================================================

$ErrorActionPreference = 'Stop'

# Use UTF-8 for console output
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# Project root (folder of this script)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Find a free TCP port in the given range
function Find-FreePort {
    param([int]$Start = 8080, [int]$End = 8200)
    for ($p = $Start; $p -le $End; $p++) {
        try {
            $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
            $l.Start()
            $l.Stop()
            return $p
        } catch {
            continue
        }
    }
    throw 'No free port found in range 8080-8200.'
}

# MIME type map
$mime = @{
    '.html'  = 'text/html; charset=utf-8'
    '.htm'   = 'text/html; charset=utf-8'
    '.css'   = 'text/css; charset=utf-8'
    '.js'    = 'application/javascript; charset=utf-8'
    '.mjs'   = 'application/javascript; charset=utf-8'
    '.json'  = 'application/json; charset=utf-8'
    '.txt'   = 'text/plain; charset=utf-8'
    '.png'   = 'image/png'
    '.jpg'   = 'image/jpeg'
    '.jpeg'  = 'image/jpeg'
    '.gif'   = 'image/gif'
    '.svg'   = 'image/svg+xml'
    '.ico'   = 'image/x-icon'
    '.wasm'  = 'application/wasm'
    '.woff'  = 'font/woff'
    '.woff2' = 'font/woff2'
}

$port = Find-FreePort
$prefix = "http://localhost:$port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
} catch {
    Write-Host 'Failed to start HTTP server (firewall/permission?).' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host 'Press Enter to exit'
    exit 1
}

$url = "http://localhost:$port/index.html"

Write-Host '====================================================' -ForegroundColor Cyan
Write-Host '   Dual-Hand AR Dimensional Rift - server started' -ForegroundColor Cyan
Write-Host "   URL : $url" -ForegroundColor Green
Write-Host '   Close this window to stop the server.' -ForegroundColor DarkGray
Write-Host '====================================================' -ForegroundColor Cyan

# Open default browser
try { Start-Process $url } catch {}

# Main serve loop
while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $rel = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath.TrimStart('/'))
        if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
        $rel = $rel -replace '/', '\'

        $path = Join-Path $root $rel

        # Prevent directory traversal
        $fullRoot = [System.IO.Path]::GetFullPath($root)
        $fullPath = ''
        try { $fullPath = [System.IO.Path]::GetFullPath($path) } catch {}

        if ($fullPath -and $fullPath.StartsWith($fullRoot) -and (Test-Path $path -PathType Leaf)) {
            $bytes = [System.IO.File]::ReadAllBytes($path)
            $ext = [System.IO.Path]::GetExtension($path).ToLower()
            if ($mime.ContainsKey($ext)) {
                $response.ContentType = $mime[$ext]
            } else {
                $response.ContentType = 'application/octet-stream'
            }
            $response.Headers.Add('Cache-Control', 'no-cache')
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $response.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
            $response.ContentType = 'text/plain; charset=utf-8'
            $response.OutputStream.Write($msg, 0, $msg.Length)
        }

        $response.OutputStream.Close()
    } catch {
        # Ignore per-request errors, keep serving
    }
}
