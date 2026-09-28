# One command: upload unuploaded assets to Cloudinary, then git add/commit/push.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/sync-push.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/sync-push.ps1 -Message "update work"
#   npm run sync-push
param(
  [string]$Message = "sync: cloudinary urls + site update"
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)  # repo root (ewebsite/)

Write-Host "== 1/3 Cloudinary: uploading unuploaded assets + linking index.html ==" -ForegroundColor Cyan
node scripts/upload-cloudinary.js --link
if ($LASTEXITCODE -ne 0) { throw "Cloudinary upload step failed." }

Write-Host "`n== 2/3 Git: untracking large assets now served by Cloudinary ==" -ForegroundColor Cyan
# Remove already-tracked asset blobs from the index (keeps local files). Respects .gitignore afterwards.
$trackedAssets = @(git ls-files "images/*" "videos/*" "works/*.mp4" "works/*.MP4" "works/*.mov" "works/*.webm" "works/*.jpg" "works/*.JPG" "works/*.jpeg" "works/*.JPEG" "works/*.png" "works/*.PNG" "works/*.webp" "works/*.gif")
if ($trackedAssets) {
  git rm --cached -q $trackedAssets
  Write-Host "Untracked $($trackedAssets.Count) asset file(s) from git index (local files kept)."
} else {
  Write-Host "No tracked assets to untrack."
}

Write-Host "`n== 3/3 Git: add, commit, push ==" -ForegroundColor Cyan
git add -A
$staged = git diff --cached --name-only
if ([string]::IsNullOrWhiteSpace($staged)) {
  Write-Host "Nothing to commit. Working tree clean."
} else {
  Write-Host "Staging:"
  Write-Host $staged
  git commit -m $Message
  git push
  if ($LASTEXITCODE -ne 0) { throw "git push failed (see error above). If GitHub reports a file over 100 MB, run this script again - it un-stages large assets before committing." }
  Write-Host "Pushed." -ForegroundColor Green
}
