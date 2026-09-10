import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** OCR worker execution limits. */
export const OCR_TIMEOUT_MS = 30000;          // unchanged: preprocessing + 2 OCR passes
const OCR_MAX_BUFFER = 8 * 1024 * 1024;       // was Node's 1 MB default

/**
 * Run OCR on an image file using a child worker process.
 * Returns raw text, preprocessed text, and Tesseract confidence score.
 *
 * SECURITY (Phase H2, narrowly scoped): this previously used `exec`, which
 * builds a SHELL command string with the file path interpolated into it. A
 * stored filename can contain a double quote — `path.extname('x.jp"g')` returns
 * `.jp"g`, and backend/middleware/uploadMiddleware.js takes a guest identity
 * document's extension straight from the client-supplied `originalname` — so a
 * crafted upload could break out of the quoting and execute arbitrary commands.
 *
 * `execFile` passes the arguments as an array and spawns the binary directly
 * with no shell, which removes that entire class of injection for every caller.
 * `process.execPath` is used instead of the string "node" so the worker always
 * runs on the same interpreter as the server rather than whatever is on PATH.
 *
 * The failure contract is unchanged: any error resolves to empty text with zero
 * confidence, so callers never have to distinguish failure modes.
 *
 * Pixel-bomb protection is NOT weakened here. ocrWorker.js calls sharp without
 * `limitInputPixels`, so sharp's ~268 MP default guard stays active, and the
 * Phase H1 upload ceiling (12000px per side, ~50 MP) is stricter still.
 */
export const extractOCRData = (filePath, mimeType) => {
  return new Promise((resolve) => {
    const workerPath = path.join(__dirname, 'ocrWorker.js');

    execFile(
      process.execPath,
      [workerPath, String(filePath), String(mimeType)],
      {
        timeout: OCR_TIMEOUT_MS,
        killSignal: 'SIGKILL',   // a wedged tesseract must not survive SIGTERM
        maxBuffer: OCR_MAX_BUFFER,
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          console.error('OCR Worker Error:', error.message);
          resolve({ rawText: '', preprocessedText: '', confidence: 0 });
          return;
        }
        try {
          const data = JSON.parse(stdout);
          resolve(data);
        } catch (e) {
          resolve({ rawText: stdout, preprocessedText: stdout, confidence: 0 });
        }
      }
    );
  });
};

export const verifyDocumentData = (ocrData, idType, documentNumber = null) => {
  const { preprocessedText, confidence } = ocrData;
  
  if (!preprocessedText || preprocessedText.trim() === '') {
    return {
      success: false,
      score: 0,
      reason: 'unreadable',
      message: 'Document appears blank or unreadable. Please upload a clearer scan.'
    };
  }

  // If OCR confidence is too low, return specific message
  if (confidence > 0 && confidence < 40) {
    return {
      success: false,
      score: confidence,
      reason: 'low_confidence',
      message: 'Document image is unclear. Please upload a clearer or properly oriented image.'
    };
  }

  const upperText = preprocessedText.toUpperCase();
  const cleanText = upperText.replace(/[^A-Z0-9]/g, ''); // Normalized alphanumeric text
  
  let score = 0;
  
  // Compare document number using normalized text
  if (documentNumber) {
    const cleanNumber = documentNumber.replace(/[^A-Z0-9]/g, '').toUpperCase();
    if (cleanText.includes(cleanNumber)) {
      score += 100; // Perfect normalized match bypass
    }
  }

  // Confidence-based verification (combinations of keywords)
  let keywords = [];
  switch (idType) {
    case 'Aadhaar Card':
      keywords = ['AADHAAR', 'GOVERNMENT', 'INDIA', 'UNIQUE', 'IDENTIFICATION'];
      break;
    case 'Passport':
      keywords = ['PASSPORT', 'REPUBLIC', 'INDIA'];
      break;
    case 'Driving Licence':
      keywords = ['DRIVING', 'LICENCE', 'LICENSE', 'UNIONOFINDIA', 'TRANSPORT', 'VALIDITY'];
      break;
    case 'Voter ID':
      keywords = ['ELECTION', 'COMMISSION', 'ELECTOR', 'VOTER', 'IDENTITY'];
      break;
  }

  for (let kw of keywords) {
    const cleanKw = kw.replace(/[^A-Z0-9]/g, '');
    if (cleanText.includes(cleanKw)) {
      score += 20;
    }
  }

  if (score >= 40) {
    return {
      success: true,
      score,
      reason: 'match',
      message: 'Document verified successfully.'
    };
  }

  return {
    success: false,
    score,
    reason: 'mismatch',
    message: `Document does not appear to be a valid ${idType}.`
  };
};
