/**
 * inventoryUploadMiddleware.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Multer upload middleware and file lifecycle helpers for inventory product photos.
 * Storage location: backend/inventory-photos/
 */

import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const inventoryPhotosDir = path.join(__dirname, '..', 'inventory-photos');

// Ensure directory exists synchronously
if (!fs.existsSync(inventoryPhotosDir)) {
  fs.mkdirSync(inventoryPhotosDir, { recursive: true });
}

// Storage configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, inventoryPhotosDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueSuffix = crypto.randomUUID();
    cb(null, `prod_${uniqueSuffix}${ext}`);
  }
});

// File filter (JPG, JPEG, PNG only)
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/jpg'];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, JPG, and PNG images are allowed for product photos.'), false);
  }
};

export const uploadProductPhoto = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5 MB max size
  }
});

/**
 * Safely cleans up an old product photo file.
 * Requirement 2:
 * - Safely remove previous photo if inside inventory-photos directory.
 * - Never delete files outside dedicated inventory-photos directory.
 * - If deletion fails, log warning without throwing error to prevent DB failure.
 */
export async function removeOldProductPhoto(oldPhotoUrl) {
  if (!oldPhotoUrl || typeof oldPhotoUrl !== 'string') return;

  try {
    const filename = path.basename(oldPhotoUrl);
    const targetPath = path.resolve(path.join(inventoryPhotosDir, filename));
    const resolvedBase = path.resolve(inventoryPhotosDir);

    // Security check: ensure target path is inside inventoryPhotosDir
    if (!targetPath.startsWith(resolvedBase)) {
      console.warn(`[Inventory Cleanup] Blocked attempt to delete file outside inventory-photos directory: ${targetPath}`);
      return;
    }

    if (fs.existsSync(targetPath)) {
      await fs.promises.unlink(targetPath);
      console.log(`[Inventory Cleanup] Removed old product photo: ${filename}`);
    }
  } catch (err) {
    console.warn(`[Inventory Cleanup Warning] Could not remove old product photo (${oldPhotoUrl}):`, err.message);
  }
}
