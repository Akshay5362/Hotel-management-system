/**
 * backend/controllers/foodWaiterController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Controller for Restaurant Waiter Master.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  listFoodWaitersFirestore,
  getFoodWaiterByIdFirestore,
  createFoodWaiterFirestore,
  updateFoodWaiterFirestore,
  deleteFoodWaiterFirestore
} from '../repositories/firestore/foodWaitersRepository.js';
import { RepositoryError } from '../repositories/firestore/firestoreUtils.js';

function handleRepoError(res, err, context) {
  if (err instanceof RepositoryError) {
    const status = err.status || 500;
    console.warn(`[FoodWaiterController] ${context} - RepositoryError (${err.code}): ${err.message}`);
    return res.status(status).json({ error: err.message, code: err.code });
  }
  console.error(`[FoodWaiterController] ${context} - Unexpected error:`, err);
  return res.status(500).json({ error: 'Internal Server Error' });
}

export async function getFoodWaiters(req, res) {
  try {
    const activeOnly = req.query.active_only === 'true';
    const waiters = await listFoodWaitersFirestore({ activeOnly });
    return res.json({ count: waiters.length, waiters });
  } catch (err) {
    return handleRepoError(res, err, 'getFoodWaiters');
  }
}

export async function getFoodWaiterById(req, res) {
  try {
    const waiter = await getFoodWaiterByIdFirestore(req.params.id);
    if (!waiter) return res.status(404).json({ error: 'Waiter not found', code: 'NOT_FOUND' });
    return res.json(waiter);
  } catch (err) {
    return handleRepoError(res, err, 'getFoodWaiterById');
  }
}

export async function createFoodWaiter(req, res) {
  try {
    const waiter = await createFoodWaiterFirestore(req.body);
    return res.status(201).json(waiter);
  } catch (err) {
    return handleRepoError(res, err, 'createFoodWaiter');
  }
}

export async function updateFoodWaiter(req, res) {
  try {
    const updated = await updateFoodWaiterFirestore(req.params.id, req.body);
    return res.json(updated);
  } catch (err) {
    return handleRepoError(res, err, 'updateFoodWaiter');
  }
}

export async function deleteFoodWaiter(req, res) {
  try {
    await deleteFoodWaiterFirestore(req.params.id);
    return res.json({ success: true, message: 'Waiter deleted successfully' });
  } catch (err) {
    return handleRepoError(res, err, 'deleteFoodWaiter');
  }
}
