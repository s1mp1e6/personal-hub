#Requires -Version 5.1
<#
  在 Cloudflare 上为 zal.best 添加 hub 子域名（CNAME）和可选验证 TXT
  用法:
    $env:CLOUDFLARE_API_TOKEN = "你的Token"
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/cloudflare-add-dns.ps1 -CnameTarget "xxxx.edgeone.app" [-TxtName "hub" -TxtValue "验证串"]
  说明:
    Token 只在你的本机使用，不会上传。
    建议在 Cloudflare -> My Profile -> API Tokens 创建 "Edit zone DNS" 模板，Zone 只限 zal.best。
#>
param(
  [string]$Token = $env:CLOUDFLARE_API_TOKEN,
  [string]$ZoneName = "zal.best",
  [Parameter(Mandatory = $true)][string]$CnameTarget,
  [string]$TxtName = "",
  [string]$TxtValue = ""
)

$ErrorActionPreference = "Stop"
$base = "https://api.cloudflare.com/client/v4"

if ([string]::IsNullOrWhiteSpace($Token)) {
  throw "缺少 Cloudflare API Token：请设置环境变量 CLOUDFLARE_API_TOKEN 或传入 -Token。"
}

function Invoke-CF {
  param([string]$Method, [string]$Path, [object]$Body = $null)
  $headers = @{ "Authorization" = "Bearer $Token" }
  $params = @{ Uri = "$base$Path"; Method = $Method; Headers = $headers; ContentType = "application/json" }
  if ($null -ne $Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10) }
  $resp = Invoke-RestMethod @params
  if (-not $resp.success) {
    throw "Cloudflare API 失败: $($resp.errors | ConvertTo-Json -Compress)"
  }
  return $resp.result
}

Write-Host "== 1. 定位 Zone: $ZoneName ==" -ForegroundColor Cyan
$zones = Invoke-CF -Method GET -Path "/zones?name=$([uri]::EscapeDataString($ZoneName))"
if (-not $zones -or $zones.Count -eq 0) { throw "找不到 Zone $ZoneName，请检查 Token 权限和账号。可先执行: .\tools\check-deployment.ps1 确认 NS 是否指向 Cloudflare。" }
$zoneId = $zones[0].id
Write-Host "Zone ID: $zoneId" -ForegroundColor Green

if ($TxtName -and $TxtValue) {
  Write-Host "== 2. 添加/核对验证 TXT ==" -ForegroundColor Cyan
  $txtFull = if ($TxtName -eq "@") { $ZoneName } else { "$TxtName.$ZoneName" }
  $existingTxt = Invoke-CF -Method GET -Path "/zones/$zoneId/dns_records?type=TXT&name=$([uri]::EscapeDataString($txtFull))"
  $match = @($existingTxt) | Where-Object { $_.content -eq $TxtValue } | Select-Object -First 1
  if ($match) {
    Write-Host "TXT 已存在且内容一致，跳过。" -ForegroundColor Green
  } else {
    $created = Invoke-CF -Method POST -Path "/zones/$zoneId/dns_records" -Body @{ type = "TXT"; name = $txtFull; content = $TxtValue; ttl = 1 }
    Write-Host "TXT 已创建: $($created.name) -> $($created.content)" -ForegroundColor Green
  }
}

Write-Host "== 3. 添加/核对 hub CNAME ==" -ForegroundColor Cyan
$cnameFull = "hub.$ZoneName"
$existingCname = Invoke-CF -Method GET -Path "/zones/$zoneId/dns_records?type=CNAME&name=$([uri]::EscapeDataString($cnameFull))"
if (@($existingCname).Count -gt 0) {
  $record = @($existingCname)[0]
  if ($record.content -eq $CnameTarget) {
    Write-Host "CNAME 已存在且目标一致: $cnameFull -> $CnameTarget" -ForegroundColor Green
  } else {
    $updated = Invoke-CF -Method PUT -Path "/zones/$zoneId/dns_records/$($record.id)" -Body @{ type = "CNAME"; name = $cnameFull; content = $CnameTarget; ttl = 1; proxied = $false }
    Write-Host "CNAME 已更新: $cnameFull -> $($updated.content)" -ForegroundColor Green
  }
} else {
  $created = Invoke-CF -Method POST -Path "/zones/$zoneId/dns_records" -Body @{ type = "CNAME"; name = $cnameFull; content = $CnameTarget; ttl = 1; proxied = $false }
  Write-Host "CNAME 已创建: $cnameFull -> $($created.content)" -ForegroundColor Green
}

Write-Host "== 4. 复测 DNS 解析 ==" -ForegroundColor Cyan
try {
  $r = Resolve-DnsName $cnameFull -Type CNAME -ErrorAction Stop
  $r | Select-Object Name, NameHost | Format-Table -AutoSize
  Write-Host "DNS 已生效。接着回 EdgeOne 点验证，并开启免费 HTTPS 证书。" -ForegroundColor Green
} catch {
  Write-Host "记录已写入，但本地 DNS 缓存可能还没更新，通常几分钟到 48 小时内生效。" -ForegroundColor Yellow
}