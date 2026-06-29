# AIQuiz local launcher server
# Serves the folder this script lives in over http://localhost:<port>/
# Requires only Windows PowerShell (no Node.js, no Python).

$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
Set-Location -LiteralPath $root

# --- find a free TCP port -------------------------------------------------
$probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
$probe.Start()
$port = $probe.LocalEndpoint.Port
$probe.Stop()

$prefix = "http://localhost:$port/"
$http = New-Object System.Net.HttpListener
$http.Prefixes.Add($prefix)
try {
    $http.Start()
} catch {
    Write-Host ""
    Write-Host "[ERROR] Could not start the local server:" -ForegroundColor Red
    Write-Host "        $($_.Exception.Message)"
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

$mime = @{
    '.html'='text/html; charset=utf-8'; '.htm'='text/html; charset=utf-8';
    '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8';
    '.json'='application/json; charset=utf-8'; '.svg'='image/svg+xml';
    '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg';
    '.gif'='image/gif'; '.webp'='image/webp'; '.ico'='image/x-icon';
    '.pdf'='application/pdf'; '.woff2'='font/woff2'; '.woff'='font/woff'
}

$htmls = @(Get-ChildItem -LiteralPath $root -Filter *.html -File)
$openUrl = $prefix
if ($htmls.Count -eq 1) {
    $openUrl = $prefix + [System.Uri]::EscapeDataString($htmls[0].Name)
}

Write-Host ""
Write-Host "  ===================================================="
Write-Host "   AIQuiz is now running on a local server"
Write-Host "   URL: $openUrl"
Write-Host "  ===================================================="
Write-Host ""
Write-Host "  * Keep this window OPEN while you use the app."
Write-Host "  * Closing this window stops the app."
Write-Host ""

try { Start-Process $openUrl } catch {}

$rootPrefix = $root.TrimEnd('\') + '\'

while ($http.IsListening) {
    try {
        $ctx = $http.GetContext()
    } catch {
        break
    }
    $req = $ctx.Request
    $res = $ctx.Response
    try {
        $relPath = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')

        if ([string]::IsNullOrWhiteSpace($relPath)) {
            if ($htmls.Count -eq 1) {
                $res.StatusCode = 302
                $res.RedirectLocation = '/' + [System.Uri]::EscapeDataString($htmls[0].Name)
            } else {
                $sb = New-Object System.Text.StringBuilder
                [void]$sb.Append('<!DOCTYPE html><meta charset="utf-8"><title>AIQuiz</title>')
                [void]$sb.Append('<body style="font-family:sans-serif;background:#0d0f14;color:#f0f1f5;padding:40px">')
                [void]$sb.Append('<h2>AIQuiz</h2><p>Select a file to open:</p><ul>')
                foreach ($h in $htmls) {
                    $enc = [System.Uri]::EscapeDataString($h.Name)
                    [void]$sb.Append("<li style='margin:8px 0'><a style='color:#7c6af5' href='/$enc'>")
                    [void]$sb.Append([System.Net.WebUtility]::HtmlEncode($h.Name))
                    [void]$sb.Append('</a></li>')
                }
                [void]$sb.Append('</ul></body>')
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($sb.ToString())
                $res.ContentType = 'text/html; charset=utf-8'
                $res.ContentLength64 = $bytes.Length
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
            $res.Close()
            continue
        }

        $relPath = $relPath -replace '/', '\'
        $full = [System.IO.Path]::GetFullPath((Join-Path $root $relPath))

        if (-not $full.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            $res.StatusCode = 403
            $res.Close()
            continue
        }

        if (Test-Path -LiteralPath $full -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
            $ct = $mime[$ext]
            if (-not $ct) { $ct = 'application/octet-stream' }
            $bytes = [System.IO.File]::ReadAllBytes($full)
            $res.ContentType = $ct
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $res.StatusCode = 404
            $nf = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
            $res.OutputStream.Write($nf, 0, $nf.Length)
        }
    } catch {
        try { $res.StatusCode = 500 } catch {}
    } finally {
        try { $res.Close() } catch {}
    }
}
