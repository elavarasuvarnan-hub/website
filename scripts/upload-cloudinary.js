/**
 * Upload unuploaded local assets to Cloudinary, mark them as uploaded,
 * and optionally rewrite index.html to use Cloudinary URLs.
 *
 * Usage:
 *   npm install
 *   Copy-Item .env.example .env   # then fill CLOUDINARY_* values
 *   node scripts/upload-cloudinary.js            # upload only
 *   node scripts/upload-cloudinary.js --link     # upload + rewrite index.html
 *   node scripts/upload-cloudinary.js --force    # re-upload even if marked uploaded
 *
 * Tracking file: cloudinary-manifest.json
 *   { "<relative/path>": { url, public_id, resource_type, bytes, uploaded, uploadedAt } }
 * Files already marked uploaded:true are SKIPPED unless --force is passed.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const cloudinary = require('cloudinary').v2;

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'cloudinary-manifest.json');
const INDEX_PATH = path.join(ROOT, 'index.html');
const FOLDER = process.env.CLOUDINARY_FOLDER || 'ewebsite';

const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.error('Missing Cloudinary env vars. Copy .env.example to .env and fill:');
  console.error('  CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET');
  process.exit(1);
}
cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
});

const ARGS = process.argv.slice(2);
const DO_LINK = ARGS.includes('--link');
const FORCE = ARGS.includes('--force');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm']);
const SCAN_DIRS = ['images', 'videos', 'works'];

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveManifest(m) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + '\n');
}

function walk(dirAbs, out = []) {
  if (!fs.existsSync(dirAbs)) return out;
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const full = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function sanitizeBase(nameWithoutExt) {
  return nameWithoutExt
    .replace(/\s+/g, '-')
    .replace(/[()]/g, '')
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function collectAssets() {
  const files = [];
  for (const d of SCAN_DIRS) files.push(...walk(path.join(ROOT, d)));
  return files
    .filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext);
    })
    .sort();
}

async function uploadOne(absPath) {
  const rel = path.relative(ROOT, absPath).split(path.sep).join('/');
  const ext = path.extname(absPath).toLowerCase();
  const isVideo = VIDEO_EXTS.has(ext);
  const dir = path.dirname(rel).split('/').join('_'); // images, videos, works
  const base = sanitizeBase(path.basename(absPath, path.extname(absPath)));
  const publicId = `${FOLDER}/${dir}/${base}`;
  const res = await cloudinary.uploader.upload(absPath, {
    public_id: publicId,
    folder: undefined, // public_id already contains folder
    resource_type: isVideo ? 'video' : 'image',
    overwrite: false,
    use_filename: false,
    unique_filename: false,
  });
  return {
    url: res.secure_url,
    public_id: res.public_id,
    resource_type: res.resource_type,
    bytes: res.bytes,
    uploaded: true,
    uploadedAt: new Date().toISOString(),
  };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rewrite index.html local paths -> Cloudinary URLs (idempotent + self-healing). */
function linkIndexHtml(manifest) {
  if (!fs.existsSync(INDEX_PATH)) {
    console.log('index.html not found, skipping link step.');
    return;
  }
  let html = fs.readFileSync(INDEX_PATH, 'utf8');
  const bak = INDEX_PATH + '.bak';
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, html); // one-time backup

  const cloudEsc = escapeRegex(CLOUDINARY_CLOUD_NAME);
  const folderEsc = escapeRegex(FOLDER);

  // 1) Self-heal: collapse nested prefixes left by earlier multi-runs:
  //    PREFIX PREFIX ... path  ->  PREFIX path  (keep innermost prefix)
  const singlePrefix = `https://res\\.cloudinary\\.com/${cloudEsc}/(?:image|video)/upload/v\\d+/${folderEsc}/`;
  const runRe = new RegExp(`(?:${singlePrefix}){2,}`, 'g');
  const healed = (html.match(runRe) || []).length;
  html = html.replace(runRe, (run) => {
    const singles = run.match(new RegExp(singlePrefix, 'g'));
    return singles[singles.length - 1];
  });
  if (healed > 0) console.log(`Healed ${healed} nested Cloudinary URL(s).`);

  // 2) Idempotent replace: never match inside our own Cloudinary URLs
  //    (they always contain "<FOLDER>/" right before the asset path).
  let replaced = 0;
  for (const [rel, info] of Object.entries(manifest)) {
    if (!info || !info.url) continue;
    if (html.includes(info.url)) continue; // already linked exactly -> skip
    // match: rel, URL-encoded rel (%20 for spaces), and case-insensitive
    const encoded = rel.split('/').map(encodeURIComponent).join('/');
    const rawOnce = rel.replace(/ /g, '%20');
    const variants = [...new Set([rel, encoded, rawOnce])];
    for (const v of variants) {
      const re = new RegExp(`(?<!${folderEsc}/)` + escapeRegex(v), 'gi');
      const hits = (html.match(re) || []).length;
      if (hits > 0) {
        html = html.replace(re, info.url);
        replaced += hits;
      }
    }
  }
  fs.writeFileSync(INDEX_PATH, html);
  console.log(`Linked ${replaced} reference(s) in index.html -> Cloudinary URLs.`);
}

(async () => {
  const manifest = loadManifest();
  const assets = collectAssets();
  console.log(`Found ${assets.length} local asset(s).`);

  let uploaded = 0, skipped = 0, failed = 0;
  for (const abs of assets) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const prev = manifest[rel];
    if (prev && prev.uploaded && prev.url && !FORCE) {
      skipped++;
      continue;
    }
    try {
      const sizeMB = (fs.statSync(abs).size / 1024 / 1024).toFixed(1);
      process.stdout.write(`Uploading ${rel} (${sizeMB} MB)... `);
      const info = await uploadOne(abs);
      manifest[rel] = info;
      saveManifest(manifest); // persist after EACH file = crash-safe
      uploaded++;
      console.log('OK -> ' + info.url);
    } catch (err) {
      failed++;
      console.log('FAILED: ' + (err && err.message ? err.message : err));
    }
  }
  saveManifest(manifest);
  console.log(`\nDone. uploaded=${uploaded} skipped(already marked)=${skipped} failed=${failed}`);
  console.log(`Manifest: cloudinary-manifest.json (${Object.keys(manifest).length} entries)`);

  if (DO_LINK) linkIndexHtml(manifest);
  else console.log('Tip: run with --link to rewrite index.html to Cloudinary URLs.');
})().catch((e) => { console.error(e); process.exit(1); });
