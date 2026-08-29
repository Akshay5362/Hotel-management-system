/**
 * backend/validators/checkInValidator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Strict Pre-Transaction Validation for HPMS Check-In.
 *
 * Enforces EXACTLY 8 mandatory check-in fields:
 *  1. Full Name
 *  2. Age
 *  3. Contact Number
 *  4. State
 *  5. Purpose of Visit
 *  6. Number of PAX / Adults
 *  7. Billing Instructions
 *  8. Room Rent / Night
 *
 * Optional Fields (format validated only when non-empty):
 *  - Date of Birth (DOB)
 *  - Company GST Number
 *  - Email Address
 *  - Country
 *  - Address
 *  - Arrival Date
 *  - Departure Date
 *  - Number of Children
 * ─────────────────────────────────────────────────────────────────────────────
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^[+]?[\d\s\-()]{7,20}$/;

export function validateCheckInPayload(payload = {}) {
  const errors = {};

  // ═════════════════════════════════════════════════════════════════════════
  // 1. MANDATORY FIELDS (EXACTLY 8)
  // ═════════════════════════════════════════════════════════════════════════

  // 1. Full Name (Mandatory)
  const fullName = String(payload.guestName || payload.fullName || payload.name || '').trim();
  if (!fullName) {
    errors.fullName = 'Full name is required';
  } else if (fullName.length < 2) {
    errors.fullName = 'Full name must be at least 2 characters';
  }

  // 2. Age (Mandatory)
  const rawAge = payload.age;
  const parsedAge = parseInt(rawAge, 10);
  if (rawAge === undefined || rawAge === null || String(rawAge).trim() === '') {
    errors.age = 'Age is required';
  } else if (isNaN(parsedAge) || parsedAge <= 0 || !Number.isInteger(Number(rawAge)) || parsedAge > 125) {
    errors.age = 'Age must be a valid positive integer between 1 and 125';
  }

  // 3. Contact Number / Phone (Mandatory)
  const phone = String(payload.phone || payload.contactNumber || payload.contact_number || payload.mobile || '').trim();
  if (!phone) {
    errors.contactNumber = 'Contact number is required';
  } else if (!PHONE_REGEX.test(phone) || phone.replace(/\D/g, '').length < 7) {
    errors.contactNumber = 'Please enter a valid contact number (minimum 7 digits)';
  }

  // 4. State (Mandatory)
  const state = String(payload.state || '').trim();
  if (!state) {
    errors.state = 'State is required';
  }

  // 5. Purpose of Visit (Mandatory)
  const purposeOfVisit = String(payload.purposeOfVisit || payload.purpose_of_visit || payload.purpose || '').trim();
  if (!purposeOfVisit) {
    errors.purposeOfVisit = 'Purpose of visit is required';
  }

  // 6. Number of PAX / Adults (Mandatory)
  const rawPax = payload.pax !== undefined ? payload.pax : payload.adults;
  const parsedPax = parseInt(rawPax, 10);
  if (rawPax === undefined || rawPax === null || String(rawPax).trim() === '') {
    errors.pax = 'Number of Pax is required';
  } else if (isNaN(parsedPax) || parsedPax < 1 || !Number.isInteger(Number(rawPax))) {
    errors.pax = 'Pax must be at least 1';
  }

  // 7. Billing Instructions (Mandatory)
  const billingInstructions = String(payload.billingInstruction || payload.billing_instruction || payload.billingInstructions || '').trim();
  if (!billingInstructions) {
    errors.billingInstructions = 'Billing instructions are required';
  }

  // 8. Room Rent / Tariff (Mandatory)
  const rawRoomRent = payload.roomRent !== undefined ? payload.roomRent : (payload.roomTariff !== undefined ? payload.roomTariff : (payload.rate !== undefined ? payload.rate : payload.price));
  const parsedRoomRent = parseFloat(rawRoomRent);
  if (rawRoomRent === undefined || rawRoomRent === null || String(rawRoomRent).trim() === '') {
    errors.roomRent = 'Room rent is required';
  } else if (isNaN(parsedRoomRent) || parsedRoomRent <= 0) {
    errors.roomRent = 'Room rent must be a positive number greater than 0';
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 2. OPTIONAL FIELDS (VALIDATED ONLY WHEN PROVIDED)
  // ═════════════════════════════════════════════════════════════════════════

  // Optional: Date of Birth (DOB)
  const dob = String(payload.dateOfBirth || payload.dob || '').trim();
  if (dob) {
    const dobTime = new Date(dob).getTime();
    if (isNaN(dobTime)) {
      errors.dob = 'Please enter a valid Date of Birth';
    } else if (dobTime > Date.now()) {
      errors.dob = 'Date of Birth cannot be in the future';
    }
  }

  // Optional: Company GST Number
  const gstNo = String(payload.gstNo || payload.gst_no || '').trim();

  // Optional: Email Address
  const email = String(payload.email || '').trim();
  if (email && !EMAIL_REGEX.test(email)) {
    errors.email = 'Please enter a valid email address';
  }

  // Optional: Country
  const country = String(payload.country || '').trim();

  // Optional: Address
  const address = String(payload.address || '').trim();

  // Optional: Arrival Date
  const arrivalDateStr = String(payload.checkInDate || payload.arrivalDate || '').trim();
  if (arrivalDateStr && isNaN(new Date(arrivalDateStr).getTime())) {
    errors.arrivalDate = 'Please enter a valid arrival date';
  }

  // Optional: Departure Date
  const departureDateStr = String(payload.expectedCheckoutDate || payload.departureDate || payload.expectedCheckOutDate || '').trim();
  if (departureDateStr && isNaN(new Date(departureDateStr).getTime())) {
    errors.departureDate = 'Please enter a valid departure date';
  } else if (departureDateStr && arrivalDateStr && !isNaN(new Date(arrivalDateStr).getTime()) && !isNaN(new Date(departureDateStr).getTime())) {
    const arrTime = new Date(arrivalDateStr).getTime();
    const depTime = new Date(departureDateStr).getTime();
    if (depTime <= arrTime) {
      errors.departureDate = 'Departure date must be after arrival date';
    }
  }

  // Optional: Children
  const rawChildren = payload.children;
  let parsedChildren = 0;
  if (rawChildren !== undefined && rawChildren !== null && String(rawChildren).trim() !== '') {
    parsedChildren = parseInt(rawChildren, 10);
    if (isNaN(parsedChildren) || parsedChildren < 0 || !Number.isInteger(Number(rawChildren))) {
      errors.children = 'Children must be a non-negative integer';
    }
  }

  // Optional: Gender
  const gender = String(payload.gender || '').trim();

  // Optional: Pincode
  const pincode = String(payload.pincode || '').trim();

  const isValid = Object.keys(errors).length === 0;

  return {
    isValid,
    errors,
    sanitized: isValid ? {
      guestName: fullName,
      age: parsedAge,
      dob: dob || null,
      dateOfBirth: dob || null,
      gender: gender || null,
      phone,
      email,
      country,
      state,
      address,
      pincode: pincode || '',
      purposeOfVisit,
      pax: parsedPax,
      children: parsedChildren,
      checkInDate: arrivalDateStr ? arrivalDateStr.split('T')[0] : '',
      departureDate: departureDateStr || '',
      billingInstruction: billingInstructions,
      roomTariff: parsedRoomRent,
      gstNo: gstNo || '',
      gst_no: gstNo || ''
    } : null
  };
}

export default {
  validateCheckInPayload
};
