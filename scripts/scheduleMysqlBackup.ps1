# scheduleMysqlBackup.ps1
# ==============================================================================
# HPMS Automated MySQL Backup PowerShell Launcher for Windows Task Scheduler
# ==============================================================================

$ProjectRoot = "d:\projects\hotel"
$LogDir = Join-Path $ProjectRoot "backups\mysql"

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$LogFile = Join-Path $LogDir "scheduled_backup.log"
$Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

"[$Timestamp] Starting HPMS Scheduled MySQL Backup..." | Out-File -FilePath $LogFile -Append -Encoding utf8

Set-Location -Path $ProjectRoot

# Execute Node.js backup script
$output = node scripts/backupMysql.js 2>&1
$exitCode = $LASTEXITCODE

"[$Timestamp] Execution Output:" | Out-File -FilePath $LogFile -Append -Encoding utf8
$output | Out-File -FilePath $LogFile -Append -Encoding utf8
"[$Timestamp] Finished with Exit Code: $exitCode`n----------------------------------------" | Out-File -FilePath $LogFile -Append -Encoding utf8

exit $exitCode

