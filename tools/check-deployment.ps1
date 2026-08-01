#Requires -Version 5.1
<#
  检查 Personal Hub 域名部署是否生效
  用法: powershell -ExecutionPolicy Bypass -File tools/check-deployment.ps1
#>
$ErrorActionPreference = 'Stop'

Write-Host "== 1. zal.best 的 NS（应指向 Cloudflare） ==" -ForegroundColor Cyan
try {
  Resolve-DnsName zal.best -Type NS -ErrorAction Stop | Select-Object Name, NameHost | Format-Table -AutoSize
} catch {
  Write-Host "NS 查询失败: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "== 2. hub.zal.best 的 CNAME（应指向 EdgeOne） ==" -ForegroundColor Cyan
$cname = $null
try {
  $cname = Resolve-DnsName hub.zal.best -Type CNAME -ErrorAction Stop
  $cname | Select-Object Name, NameHost | Format-Table -AutoSize
} catch {
  Write-Host "hub.zal.best 还没有 CNAME 记录，先完成 EdgeOne 绑定和 DNS 添加。" -ForegroundColor Yellow
}

Write-Host "== 3. https://hub.zal.best 访问测试 ==" -ForegroundColor Cyan
if ($cname) {
  try {
    $r = Invoke-WebRequest -Uri "https://hub.zal.best" -UseBasicParsing -TimeoutSec 20 -MaximumRedirection 5
    $size = if ($r.Content) { $r.RawContentLength } else { 0 }
    Write-Host ("HTTP " + [int]$r.StatusCode + "，返回内容约 " + $size + " 字节") -ForegroundColor Green
    if ([int]$r.StatusCode -ge 200 -and [int]$r.StatusCode -lt 400) {
      Write-Host "首页可访问，部署验证通过。" -ForegroundColor Green
    } else {
      Write-Host "首页返回异常状态码，需要看 EdgeOne 部署日志。" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "首页访问失败: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "常见原因：DNS 未生效、EdgeOne 未绑定成功、HTTPS 证书未配置完成。" -ForegroundColor Yellow
  }
} else {
  Write-Host "先完成 DNS，再运行本脚本验证 HTTPS。" -ForegroundColor Yellow
}

Write-Host "== 4. 同步信令健康检查 ==" -ForegroundColor Cyan
try {
  $relay = "https://personal-hub-shortcode-relay.zal-pc-remote.workers.dev/health"
  $h = Invoke-WebRequest -Uri $relay -UseBasicParsing -TimeoutSec 15
  Write-Host ("信令 /health HTTP " + [int]$h.StatusCode + "，内容: " + $h.Content) -ForegroundColor Green
} catch {
  Write-Host "信令健康检查失败（不影响打开首页，只影响短码连接）: $($_.Exception.Message)" -ForegroundColor Yellow
}