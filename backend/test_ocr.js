import { extractText } from './services/ocrService.js';
import fs from 'fs';

async function testOCR() {
  console.log('Testing OCR...');
  try {
    fs.writeFileSync('test_image.jpg', 'fake image data');
    const text = await extractText('test_image.jpg', 'image/jpeg');
    console.log('Text extracted:', text);
  } catch (error) {
    console.error('Test OCR Failed:', error);
  }
}

testOCR();
