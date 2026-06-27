# sync-skills.ps1 — copy local skills directory to the pocket-claude VM
# Usage: .\scripts\sync-skills.ps1 -Remote ubuntu@1.2.3.4
#        .\scripts\sync-skills.ps1 -Remote ubuntu@1.2.3.4 -SkillsDir C:\custom\skills
#        .\scripts\sync-skills.ps1 -Remote ubuntu@1.2.3.4 -Remove brand-identity
param(
    [Parameter(Mandatory)][string]$Remote,
    [string]$SkillsDir = "$env:USERPROFILE\.claude\skills",
    [string]$Remove = "",
    [string]$KeyFile = ""
)

function Write-Info  { Write-Host "==> $args" -ForegroundColor Cyan }
function Write-Ok    { Write-Host " v  $args" -ForegroundColor Green }
function Write-Err   { Write-Host "ERROR: $args" -ForegroundColor Red; exit 1 }

# Auto-detect SSH key if not specified
if (-not $KeyFile) {
    $candidates = @(
        "$env:USERPROFILE\.ssh\id_ed25519",
        "$env:USERPROFILE\.ssh\id_rsa",
        "$env:USERPROFILE\.ssh\id_ecdsa"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { $KeyFile = $c; break }
    }
}
$sshOpts = if ($KeyFile) { @("-i", $KeyFile, "-o", "StrictHostKeyChecking=accept-new") } else { @("-o", "StrictHostKeyChecking=accept-new") }
if ($KeyFile) { Write-Info "Using key: $KeyFile" }

function Invoke-SSH { ssh @sshOpts $Remote $args[0] }
function Invoke-SCP { scp @sshOpts -r $args[0] "${Remote}:$($args[1])" }

# Handle --Remove
if ($Remove) {
    Write-Info "Removing skill '$Remove' from VM..."
    Invoke-SSH "sudo rm -rf /home/claude/.claude/skills/$Remove && echo removed"
    Write-Ok "Removed '$Remove'. Restart: ssh $Remote 'sudo systemctl restart pocket-claude'"
    exit 0
}

if (-not (Test-Path $SkillsDir)) {
    Write-Err "Skills directory not found: $SkillsDir"
}

$skills = Get-ChildItem -Path $SkillsDir -Directory
if ($skills.Count -eq 0) { Write-Err "No skill subdirectories found in $SkillsDir" }

Write-Info "Syncing $($skills.Count) skill(s) from $SkillsDir -> ${Remote}:/home/claude/.claude/skills/"

# Ensure target exists on VM
Invoke-SSH "sudo mkdir -p /home/claude/.claude/skills && sudo chown -R claude:claude /home/claude/.claude/skills"

# Copy each skill directory using scp (built into Windows 10+)
foreach ($skill in $skills) {
    Write-Host "  Copying $($skill.Name)..." -ForegroundColor DarkGray
    Invoke-SCP "$($skill.FullName)" "/tmp/skill-$($skill.Name)"
    Invoke-SSH "sudo cp -r /tmp/skill-$($skill.Name) /home/claude/.claude/skills/$($skill.Name) && sudo chown -R claude:claude /home/claude/.claude/skills/$($skill.Name) && rm -rf /tmp/skill-$($skill.Name)"
}

Write-Ok "Synced successfully"
Write-Host ""
Write-Info "Skills on VM:"
Invoke-SSH "sudo ls /home/claude/.claude/skills/ 2>/dev/null" | ForEach-Object { Write-Host "  - $_" }
Write-Host ""
Write-Info "Restart to activate: ssh $Remote 'sudo systemctl restart pocket-claude'"
