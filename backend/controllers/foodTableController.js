/**
 * backend/controllers/foodTableController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Controller for Restaurant Table Master (Phase 2B).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  listFoodTablesFirestore,
  getFoodTableByIdFirestore,
  createFoodTableFirestore,
  updateFoodTableFirestore,
  deleteFoodTableFirestore
} from '../repositories/firestore/foodTablesRepository.js';
import { RepositoryError } from '../repositories/firestore/firestoreUtils.js';

function handleRepoError(res, err, context) {
  if (err instanceof RepositoryError) {
    const status = err.status || 500;
    console.warn(`[FoodTableController] ${context} - RepositoryError (${err.code}): ${err.message}`);
    return res.status(status).json({ error: err.message, code: err.code });
  }
  console.error(`[FoodTableController] ${context} - Unexpected error:`, err);
  return res.status(500).json({ error: 'Internal Server Error' });
}

export async function getFoodTables(req, res) {
  try {
    const activeOnly = req.query.active_only === 'true';
    const tables = await listFoodTablesFirestore({ activeOnly });
    return res.json({ count: tables.length, tables });
  } catch (err) {
    return handleRepoError(res, err, 'getFoodTables');
  }
}

export async function getFoodTableById(req, res) {
  try {
    const table = await getFoodTableByIdFirestore(req.params.id);
    if (!table) return res.status(404).json({ error: 'Table not found', code: 'NOT_FOUND' });
    return res.json(table);
  } catch (err) {
    return handleRepoError(res, err, 'getFoodTableById');
  }
}

export async function createFoodTable(req, res) {
  try {
    const table = await createFoodTableFirestore(req.body);
    return res.status(201).json(table);
  } catch (err) {
    return handleRepoError(res, err, 'createFoodTable');
  }
}

export async function updateFoodTable(req, res) {
  try {
    const updated = await updateFoodTableFirestore(req.params.id, req.body);
    return res.json(updated);
  } catch (err) {
    return handleRepoError(res, err, 'updateFoodTable');
  }
}

export async function deleteFoodTable(req, res) {
  try {
    await deleteFoodTableFirestore(req.params.id);
    return res.json({ success: true, message: 'Table deleted successfully' });
  } catch (err) {
    return handleRepoError(res, err, 'deleteFoodTable');
  }
}
