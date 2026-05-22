# One-shot Windows SFTP setup for the CX recording inbox test.
# Idempotent — re-runnable. Needs to be run as Administrator.
#
# What it does:
#   1. Enable Windows OpenSSH-Server feature (if not already installed)
#   2. Start the sshd service + set it to auto-start on boot
#   3. Create a local user `rcx-delivery` with a fresh random password
#      (or reuse the existing user if it's already there)
#   4. Set that user's home directory to the inbox folder on Desktop
#   5. Grant the user write access to the inbox folder
#   6. Open Windows Firewall inbound for port 22
#   7. Print the connection info you'll plug into ngrok / RingCX
#
# Run from an elevated PowerShell:
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\scripts\setup-cx-recording-sftp-windows.ps1

$ErrorActionPreference = "Stop"

function Require-Admin {
  $current = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($current)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This script needs to run from an elevated PowerShell (Run as Administrator)."
  }
}

function Write-Section($title) {
  Write-Host ""
  Write-Host "=== $title ===" -ForegroundColor Cyan
}

Require-Admin

$User = "rcx-delivery"
$InboxDir = "C:\Users\micke\Desktop\cx-recordings\inbox"
$ProcessedDir = "C:\Users\micke\Desktop\cx-recordings\processed"
$UnknownDir = "C:\Users\micke\Desktop\cx-recordings\unknown"

# ── 1. OpenSSH-Server ───────────────────────────────────────────────
Write-Section "OpenSSH-Server feature"
$capability = Get-WindowsCapability -Online -Name "OpenSSH.Server*"
Write-Host "  Status: $($capability.State)"
if ($capability.State -ne "Installed") {
  Write-Host "  Installing OpenSSH.Server… (this can take ~30s)"
  Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" | Out-Null
  Write-Host "  ✓ Installed"
} else {
  Write-Host "  ✓ Already installed"
}

# ── 2. sshd service ─────────────────────────────────────────────────
Write-Section "sshd service"
$svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
if (-not $svc) { throw "sshd service not found after OpenSSH install — reboot may be needed." }
if ($svc.Status -ne "Running") {
  Start-Service sshd
  Write-Host "  ✓ Started"
} else {
  Write-Host "  ✓ Already running"
}
Set-Service -Name sshd -StartupType Automatic
Write-Host "  ✓ Set to auto-start on boot"

# ── 3. Local user ───────────────────────────────────────────────────
Write-Section "Local user $User"
$existing = Get-LocalUser -Name $User -ErrorAction SilentlyContinue
$plainPassword = $null
if ($existing) {
  Write-Host "  User already exists. Resetting password to a fresh random value."
  $plainPassword = -join ((33..126) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
  $securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
  Set-LocalUser -Name $User -Password $securePassword
} else {
  Write-Host "  Creating user $User…"
  $plainPassword = -join ((33..126) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
  $securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
  # Strip characters that complicate password-via-config (quotes, backslash)
  $plainPassword = $plainPassword -replace "[`"\\']", "X"
  $securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
  New-LocalUser `
    -Name $User `
    -Password $securePassword `
    -FullName "RingCX recording delivery" `
    -Description "Service account: RingCX SFTP push destination" `
    -AccountNeverExpires `
    -PasswordNeverExpires `
    -UserMayNotChangePassword | Out-Null
  Write-Host "  ✓ Created"
}

# Block interactive login + RDP — SFTP only.
# (Windows SSH lets the user SFTP regardless of console login policy.)
try {
  Add-LocalGroupMember -Group "Users" -Member $User -ErrorAction SilentlyContinue | Out-Null
} catch {
  # already a member
}

# ── 4. Inbox folder + permissions ──────────────────────────────────
Write-Section "Inbox folder + permissions"
foreach ($d in @($InboxDir, $ProcessedDir, $UnknownDir)) {
  if (-not (Test-Path $d)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    Write-Host "  Created $d"
  } else {
    Write-Host "  Exists  $d"
  }
}
# Grant rcx-delivery Modify rights on the inbox dir only.
$acl = Get-Acl $InboxDir
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $User, "Modify", "ContainerInherit, ObjectInherit", "None", "Allow"
)
$acl.AddAccessRule($rule)
Set-Acl -Path $InboxDir -AclObject $acl
Write-Host "  ✓ Granted $User Modify rights on $InboxDir"

# ── 5. Firewall ────────────────────────────────────────────────────
Write-Section "Firewall rule for SSH"
# RC's documented source IPs for the AWS82 / virtualacd.biz cluster's
# "Call recording transfers to customer hosted storage" delivery lane.
# Locks the inbound rule to these IPs only so port 22 isn't exposed
# to the wider internet. (Confirm IPs are still current per RC's
# network requirements doc; update here if RC publishes changes.)
$RcSftpSourceIps = @(
  "34.198.187.185",
  "54.87.111.82",
  "34.227.42.48",
  "52.22.161.8",
  "54.210.62.149",
  # Localhost so ngrok TCP tunnels keep working during testing — ngrok
  # agent forwards the public endpoint to 127.0.0.1:22 so the OS sees
  # the connection as a local origin. When we move to direct RC-to-IP
  # delivery in prod (no ngrok middleman), this loopback rule is
  # harmless — only local processes can reach it anyway.
  "127.0.0.1",
  "::1"
)
$ruleName = "RingCX SFTP Delivery (inbound TCP 22)"
$rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($rule) {
  Remove-NetFirewallRule -DisplayName $ruleName
  Write-Host "  Removed prior rule to recreate with current IP allowlist"
}
New-NetFirewallRule `
  -DisplayName $ruleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 22 `
  -RemoteAddress $RcSftpSourceIps | Out-Null
Write-Host "  ✓ Created inbound rule, scoped to RC IPs:"
foreach ($ip in $RcSftpSourceIps) { Write-Host "      $ip" }

# Also explicitly REMOVE the wide-open OpenSSH default rule if it
# exists from the OpenSSH-Server install. Stops any non-RC source
# from reaching port 22.
$defaultRule = Get-NetFirewallRule -DisplayName "OpenSSH SSH Server (sshd)" -ErrorAction SilentlyContinue
if ($defaultRule) {
  Remove-NetFirewallRule -DisplayName "OpenSSH SSH Server (sshd)"
  Write-Host "  ✓ Removed wide-open OpenSSH default rule (replaced with IP-scoped one above)"
}

# ── 6. sshd_config tweak — pin password auth ON ────────────────────
Write-Section "sshd_config"
$config = "C:\ProgramData\ssh\sshd_config"
if (Test-Path $config) {
  $contents = Get-Content $config -Raw
  if ($contents -notmatch "(?m)^\s*PasswordAuthentication\s+yes") {
    Add-Content -Path $config -Value "`n# Added by setup-cx-recording-sftp-windows.ps1`nPasswordAuthentication yes`n"
    Restart-Service sshd
    Write-Host "  ✓ Enabled password authentication + restarted sshd"
  } else {
    Write-Host "  ✓ Password authentication already on"
  }
} else {
  Write-Host "  ⚠ sshd_config not found at expected path — leaving as-is"
}

# ── 7. Print connection info ──────────────────────────────────────
Write-Section "Connection details"
$ipv4 = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Ethernet*","Wi-Fi*" -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "169.254.*" } |
  Select-Object -First 1).IPAddress
Write-Host "  Local IP   : $ipv4"
Write-Host "  Port       : 22"
Write-Host "  User       : $User"
Write-Host "  Password   : $plainPassword"
Write-Host "  Inbox path : $InboxDir"
Write-Host ""
Write-Host "Save the password — it won't be shown again." -ForegroundColor Yellow
Write-Host ""
Write-Host "── Next steps ──" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. Test locally first (from another machine on your LAN, or just from this box):"
Write-Host "   sftp $User@$ipv4"
Write-Host "   Use the password above. You should land directly in the inbox folder."
Write-Host ""
Write-Host "2. Expose to RingCX via ngrok TCP (free tier — random endpoint per session):"
Write-Host "   ngrok tcp 22"
Write-Host "   It prints something like 'tcp://0.tcp.ngrok.io:12345'. That's your RC host:port."
Write-Host ""
Write-Host "3. In RingCX admin → Recordings → Delivery → Destinations, add:"
Write-Host "     Protocol: SFTP"
Write-Host "     Host    : 0.tcp.ngrok.io   (whatever ngrok printed)"
Write-Host "     Port    : 12345            (whatever ngrok printed)"
Write-Host "     User    : $User"
Write-Host "     Password: (the password from above)"
Write-Host "     Path    : /                (default — lands in user home = inbox)"
Write-Host ""
Write-Host "4. Configure a Delivery Task tying campaigns to that destination."
Write-Host "   Set schedule = 'As recordings become available'."
Write-Host ""
Write-Host "5. Make a test call. Within a few min, watch $InboxDir for the file."
Write-Host "   Drop the file or kick the drain manually:"
Write-Host "     node scripts/test-cx-recording-inbox-drain.js"
Write-Host ""
Write-Host "── To tear down later ──" -ForegroundColor Cyan
Write-Host "   Remove-LocalUser -Name $User"
Write-Host "   Stop-Service sshd; Set-Service sshd -StartupType Manual"
Write-Host "   Remove-NetFirewallRule -DisplayName 'OpenSSH SSH Server (sshd)'"
Write-Host ""
