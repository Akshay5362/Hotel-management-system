/**
 * backend/repositories/firestore/foodPaymentsRepository.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore data-access layer for Food / Restaurant POS — Payments.
 *
 * Dedicated collection:
 *   food_payments — records of all PAY NOW transactions for food orders.
 *
 * STRICT SAFETY CONTRACT:
 *   - Completely isolated from HPMS room 'payments' collection.
 *   - Zero MySQL interactions.
 *   - Dual-write protected with atomic runTransaction support.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  getDoc,
  listDocs,
  setDoc,
  validateRequiredFields,
  RepositoryError
} from './firestoreUtils.js';

const COLLECTION = 'food_payments';

/**
 * Generates a unique document ID for a food payment record.
 * Format: fpay_{epoch_ms}_{4hex}
 */
export function generateFoodPaymentDocId() {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `fpay_${ts}_${rand}`;
}

/**
 * Reads a single food payment by ID.
 */
export async function getFoodPaymentByIdFirestore(paymentId, options = {}) {
  if (!paymentId) return null;
  const docId = String(paymentId).startsWith('fpay_') ? String(paymentId) : `fpay_${paymentId}`;
  return await getDoc(COLLECTION, docId, options);
}

/**
 * Reads all food payments for a specific food order.
 */
export async function getFoodPaymentsByOrderIdFirestore(foodOrderId, options = {}) {
  if (!foodOrderId) return [];
  const cleanId = String(foodOrderId).startsWith('forder_') ? String(foodOrderId) : `forder_${foodOrderId}`;

  return await listDocs(COLLECTION, {
    filters: [{ field: 'food_order_id', op: '==', value: cleanId }],
    orderBy: [{ field: 'created_at', direction: 'desc' }],
    transaction: options.transaction
  });
}

/**
 * Creates a new food payment record.
 */
export async function createFoodPaymentFirestore(paymentData, options = {}) {
  validateRequiredFields(paymentData, [
    'food_order_id',
    'food_order_number',
    'amount',
    'payment_method',
    'cashier_uid'
  ], 'FoodPayment');

  const paymentId = paymentData.food_payment_id || generateFoodPaymentDocId();
  const now = new Date().toISOString();

  const payload = {
    food_payment_id:   paymentId,
    food_order_id:     String(paymentData.food_order_id),
    food_order_number: String(paymentData.food_order_number),
    amount:            Number(paymentData.amount),
    currency:          paymentData.currency || 'INR',
    payment_method:    String(paymentData.payment_method),
    payment_status:    paymentData.payment_status || 'Completed',
    business_date:     paymentData.business_date || now.split('T')[0],
    cashier_uid:       String(paymentData.cashier_uid),
    cashier_name:      paymentData.cashier_name || 'Staff',
    notes:             paymentData.notes || null,
    created_at:        paymentData.created_at || now
  };

  await setDoc(COLLECTION, paymentId, payload, options);
  return { id: paymentId, ...payload };
}
