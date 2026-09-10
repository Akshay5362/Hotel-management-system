/**
 * billUploadMiddleware.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase H1 — upload middleware and file lifecycle helpers for supplier bills.
 * Storage location: backend/inventory-bills/
 *
 * SECURITY MODEL (differs deliberately from inventoryUploadMiddleware.js):
 *
 *  1. The client-declared MIME type is NEVER trusted. multer's fileFilter uses
 *     it only as a cheap first reject; the authoritative check reads the file's
 *     own magic bytes off disk afterwards.
 *  2. The stored extension is derived from the VERIFIED type, never from
 *     `originalname`. multer therefore writes a temporary extension-less file
 *     and `verifyUploadedBill` renames it once the real type is known — an
 *     attacker cannot choose the extension of anything that lands on disk.
 *  3. Pixel dimensions are inspected with sharp's metadata reader (which does
 *     not decode the image) BEFORE any pixel processing, so a decompression
 *     bomb is rejected rather than expanded in memory.
 *  4. Anything that fails any check is unlinked immediately.
 *
 * A supplier bill exposes purchase pricing, so unlike product photos this
 * directory is NEVER mounted with express.static. Retrieval goes through an
 * authenticated, role-gated streaming route (see billController.streamBillFile).
 */

import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const inventoryBillsDir = path.join(__dirname, '..', 'inventory-bills');

// Created here rather than in server.js so the storage layer owns its own
// directory, exactly as inventoryUploadMiddleware.js does for product photos.
if (!fs.existsSync(inventoryBillsDir)) {
  fs.mkdirSync(inventoryBillsDir, { recursive: true });
}

/** Hard ceilings. A phone photo of an A4 bill routinely exceeds the 5 MB used elsewhere. */
export const MAX_BILL_BYTES = 10 * 1024 * 1024;   // 10 MB
export const MAX_BILL_DIMENSION = 12000;          // px per side
export const MAX_BILL_PIXELS = 50 * 1000 * 1000;  // ~50 megapixels

/**
 * Magic-byte signatures for the only three formats H1 accepts.
 * `check` receives the first 16 bytes of the file.
 */
const SIGNATURES = [
  {
    mime: 'image/jpeg',
    ext: '.jpg',
    check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
  },
  {
    mime: 'image/png',
    ext: '.png',
    check: (b) => b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  },
  {
    mime: 'image/webp',
    ext: '.webp',
    // RIFF <4-byte size> WEBP
    check: (b) => b.length >= 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
  }
];

/** Declared types allowed through the cheap first gate. */
const DECLARED_MIME_ALLOWLIST = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, inventoryBillsDir);
  },
  filename(req, file, cb) {
    // Deliberately NO extension from originalname. The real extension is applied
    // by verifyUploadedBill once the magic bytes have been read.
    cb(null, `billtmp_${crypto.randomUUID()}.part`);
  }
});

function fileFilter(req, file, cb) {
  if (DECLARED_MIME_ALLOWLIST.has(String(file.mimetype).toLowerCase())) {
    cb(null, true);
    return;
  }
  cb(new Error('Invalid file type. Only JPEG, PNG and WebP images are accepted for supplier bills. PDF is not supported yet.'), false);
}

export const uploadBillFile = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_BILL_BYTES, files: 1 }
});

/** Removes a file, never throwing. Used on every rejection path. */
function discard(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* best effort */ }
}

/**
 * Post-multer verification. Express middleware.
 *
 * On success attaches `req.billFile`:
 *   { fileName, filePath, mimeType, ext, size, sha256, width, height }
 * On any failure the temporary file is unlinked and a 400 is returned.
 */
export async function verifyUploadedBill(req, res, next) {
  const tmpPath = req.file?.path;
  if (!req.file || !tmpPath) {
    return res.status(400).json({ error: 'A bill file is required (field name: bill).', code: 'BILL_FILE_REQUIRED' });
  }

  try {
    // The whole file is read once, up front, and every subsequent check works
    // on that buffer. sharp is deliberately never given the PATH: on Windows
    // libvips keeps a lazily-read input file open, which makes the rename below
    // fail with EBUSY for formats it streams (WebP in particular). Bounded by
    // the 10 MB multer ceiling, so buffering is safe.
    const bytes = fs.readFileSync(tmpPath);

    // ── 1. Magic bytes decide the real type ──────────────────────────────────
    const signature = SIGNATURES.find(s => s.check(bytes.subarray(0, 16)));

    if (!signature) {
      discard(tmpPath);
      return res.status(400).json({
        error: 'The uploaded file is not a valid JPEG, PNG or WebP image.',
        code: 'INVALID_FILE_SIGNATURE'
      });
    }

    // A declared type that disagrees with the bytes is a spoof attempt, not a
    // mislabelled file — reject rather than silently trusting the bytes.
    const declared = String(req.file.mimetype).toLowerCase();
    const declaredNormalised = declared === 'image/jpg' ? 'image/jpeg' : declared;
    if (declaredNormalised !== signature.mime) {
      discard(tmpPath);
      return res.status(400).json({
        error: `Declared file type '${req.file.mimetype}' does not match the actual file contents.`,
        code: 'MIME_TYPE_MISMATCH'
      });
    }

    // ── 2. Dimensions, before any pixel processing ───────────────────────────
    let meta;
    try {
      meta = await sharp(bytes, { limitInputPixels: false }).metadata();
    } catch {
      discard(tmpPath);
      return res.status(400).json({ error: 'The image could not be read.', code: 'IMAGE_UNREADABLE' });
    }

    const width = Number(meta?.width) || 0;
    const height = Number(meta?.height) || 0;
    if (width <= 0 || height <= 0) {
      discard(tmpPath);
      return res.status(400).json({ error: 'The image has no readable dimensions.', code: 'IMAGE_UNREADABLE' });
    }
    if (width > MAX_BILL_DIMENSION || height > MAX_BILL_DIMENSION) {
      discard(tmpPath);
      return res.status(400).json({
        error: `Image is too large: ${width}x${height}px exceeds the ${MAX_BILL_DIMENSION}px per-side limit.`,
        code: 'IMAGE_DIMENSIONS_TOO_LARGE'
      });
    }
    if (width * height > MAX_BILL_PIXELS) {
      discard(tmpPath);
      return res.status(400).json({
        error: `Image is too large: ${width * height} pixels exceeds the ${MAX_BILL_PIXELS} pixel limit.`,
        code: 'IMAGE_PIXELS_TOO_LARGE'
      });
    }

    // ── 3. Content hash, for duplicate detection in a later phase ────────────
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

    // ── 4. Rename to the verified extension ─────────────────────────────────
    const fileName = `bill_${crypto.randomUUID()}${signature.ext}`;
    const finalPath = path.join(inventoryBillsDir, fileName);
    fs.renameSync(tmpPath, finalPath);

    req.billFile = {
      fileName,
      filePath: finalPath,
      mimeType: signature.mime,
      ext: signature.ext,
      size: bytes.length,
      sha256,
      width,
      height
    };
    return next();
  } catch (err) {
    discard(tmpPath);
    console.error('[BillUpload] verification failed:', err);
    return res.status(400).json({ error: 'The uploaded bill could not be processed.', code: 'BILL_UPLOAD_FAILED' });
  }
}

/**
 * Resolves a stored bill filename to an absolute path inside the bills
 * directory, or null when the name escapes it. Mirrors the containment check in
 * inventoryUploadMiddleware.removeOldProductPhoto.
 */
export function resolveBillPath(fileName) {
  if (!fileName || typeof fileName !== 'string') return null;
  const base = path.basename(fileName);            // strips any directory component
  if (base !== fileName) return null;              // caller tried to supply a path
  const target = path.resolve(path.join(inventoryBillsDir, base));
  const root = path.resolve(inventoryBillsDir);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/**
 * Deletes a stored bill file. Never throws — a failed unlink must not fail the
 * surrounding request. Returns true when a file was actually removed.
 */
export async function removeBillFile(fileName) {
  const target = resolveBillPath(fileName);
  if (!target) {
    console.warn(`[BillCleanup] Blocked attempt to delete outside inventory-bills: ${fileName}`);
    return false;
  }
  try {
    if (!fs.existsSync(target)) return false;
    await fs.promises.unlink(target);
    return true;
  } catch (err) {
    console.warn(`[BillCleanup] Could not remove bill file (${fileName}):`, err.message);
    return false;
  }
}

/** multer error → 400 rather than a generic 500. Mirrors routes/inventoryRoutes.js. */
export function billUpload(req, res, next) {
  uploadBillFile.single('bill')(req, res, (err) => {
    if (err) {
      const code = err.code === 'LIMIT_FILE_SIZE' ? 'BILL_FILE_TOO_LARGE' : 'BILL_UPLOAD_REJECTED';
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? `Bill file exceeds the ${Math.round(MAX_BILL_BYTES / 1024 / 1024)} MB limit.`
        : (err.message || 'Bill upload failed.');
      return res.status(400).json({ error: message, code });
    }
    return next();
  });
}
