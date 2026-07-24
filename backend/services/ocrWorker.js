import Tesseract from 'tesseract.js';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

async function run() {
  const filePath = process.argv[2];
  const mimeType = process.argv[3];

  if (!filePath || !fs.existsSync(filePath)) {
    console.error('File not found');
    process.exit(1);
  }

  try {
    if (mimeType === 'application/pdf') {
      // PDF text extraction is temporarily disabled due to compatibility issues with pdf-parse in ESM.
      // We return empty string so it gets rejected or sent for manual admin verification.
      console.log(JSON.stringify({ rawText: '', preprocessedText: '', confidence: 0 }));
      process.exit(0);
    }

    // 1. Run OCR on raw image
    const rawRes = await Tesseract.recognize(filePath, 'eng', { 
      logger: () => {},
      langPath: path.join(__dirname, '..'),
      cachePath: path.join(__dirname, '..')
    });
    const rawText = rawRes.data.text || '';
    let confidence = rawRes.data.confidence || 0;

    // 2. Preprocess image
    const parsedPath = path.parse(filePath);
    const preprocessedPath = path.join(parsedPath.dir, parsedPath.name + '_prep' + parsedPath.ext);

    let preText = '';
    try {
      await sharp(filePath)
        .rotate() // Use EXIF orientation to auto-rotate
        // Note: trim() removes uninteresting borders if they are solid color, but it can sometimes fail if it can't find a background. We omit trim() for safety on noisy images unless explicitly needed.
        .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }) // Resize to max 1800px on longest side
        .grayscale() // Convert to grayscale
        .normalize() // Normalize brightness and contrast
        .sharpen() // Sharpen image
        .median(3) // Reduce noise
        .toFile(preprocessedPath);

      // 3. Run OCR on preprocessed image
      const preRes = await Tesseract.recognize(preprocessedPath, 'eng', { 
        logger: () => {},
        langPath: path.join(__dirname, '..'),
        cachePath: path.join(__dirname, '..')
      });
      preText = preRes.data.text || '';
      confidence = preRes.data.confidence || 0;

      // Clean up preprocessed image
      try { fs.unlinkSync(preprocessedPath); } catch (e) {}
    } catch (sharpError) {
      // Fallback if sharp fails
      preText = rawText;
    }

    // 4. Output JSON
    console.log(JSON.stringify({ rawText, preprocessedText: preText, confidence }));
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

// Catch unhandled exceptions to prevent hanging
process.on('uncaughtException', (err) => {
  console.error(err);
  process.exit(1);
});

run();
