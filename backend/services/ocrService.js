import { exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Run OCR on an image file using a child worker process.
 * Returns raw text, preprocessed text, and Tesseract confidence score.
 */
export const extractOCRData = (filePath, mimeType) => {
  return new Promise((resolve) => {
    const workerPath = path.join(__dirname, 'ocrWorker.js');
    
    // Increased timeout to 30s to allow for preprocessing and 2 OCR passes
    exec(`node "${workerPath}" "${filePath}" "${mimeType}"`, { timeout: 30000 }, (error, stdout, stderr) => {
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
    });
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
