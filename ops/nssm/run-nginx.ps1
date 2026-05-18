param(
    [string]$NginxRoot = $(if ($env:NGINX_ROOT) { $env:NGINX_ROOT } else { "C:\tools\nginx-1.29.6" })
)

$ErrorActionPreference = "Stop"

$nginx = Join-Path $NginxRoot "nginx.exe"
if (-not (Test-Path -LiteralPath $nginx)) {
    throw "nginx.exe not found at $nginx"
}

& $nginx -p $NginxRoot -c "conf\nginx.conf" -g "daemon off;"
exit $LASTEXITCODE
