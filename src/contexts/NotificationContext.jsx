/**
 * src/contexts/NotificationContext.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable real-time notification layer for the Admin and Reception dashboards.
 *
 * Owns exactly ONE Socket.IO connection (opened only for recipient roles),
 * translates server events into a uniform notification model, deduplicates
 * by a stable per-event id, keeps a bounded list (mirrored to localStorage per
 * user so a page refresh neither loses history nor re-notifies), and exposes
 * toast + bell state to the UI.
 *
 * Adding a new notification kind = adding ONE entry to NOTIFICATION_TYPES.
 * (See the HOUSEKEEPING_ROOM_CLEANED template at the bottom of the registry.)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { SOCKET_URL } from '../config/apiConfig';
import { AdminAuthContext } from './AdminAuthContext';

export const NotificationContext = createContext(null);

const MAX_NOTIFICATIONS = 50;
const TOAST_AUTO_DISMISS_MS = 8000;
const STORAGE_PREFIX = 'hpms_notifications_';

// ── Role normalization (client-side mirror of the frontend's own conventions) ─
// /api/auth/me returns the RAW role ('ADMIN', 'RECEPTIONIST', 'CHEF', … or the
// root-admin shape role:'admin' with type:'admin'). ProtectedRoutes.jsx treats
// ADMIN/SUPER_ADMIN as universal; we do the same here, case-insensitively.
export function getNormalizedRole(user) {
  if (!user) return null;
  const raw = String(user.role || '').toUpperCase().trim();
  const isStaff = user.type === 'staff' || user.user_type === 'staff';
  if (raw === 'ADMIN' && !isStaff) return 'SUPER_ADMIN';
  return raw;
}

/**
 * Mirrors backend/controllers/authController.js normalizeUserRole EXACTLY.
 * The bell's own vocabulary is the raw uppercase role, but the inventory
 * approval configuration stores backend-normalized lowercase names, so a
 * notification targeted by that configuration must be compared in the same
 * vocabulary.
 */
export function getBackendNormalizedRole(user) {
  if (!user) return null;
  const raw = String(user.role || '').toUpperCase().trim();
  const isStaff = user.type === 'staff' || user.user_type === 'staff';
  if (!isStaff && raw === 'ADMIN') return 'super_admin';
  if (isStaff) {
    if (raw === 'ADMIN') return 'admin';
    if (raw === 'RECEPTIONIST') return 'receptionist';
    if (raw === 'CLEANER') return 'housekeeper';
    if (['CHEF', 'KITCHEN_HELPER', 'PANTRY_BOY'].includes(raw)) return 'kitchen';
    return raw.toLowerCase();
  }
  return raw.toLowerCase();
}

// ── Notification type registry ───────────────────────────────────────────────
// Each entry fully describes one server event → one notification kind.
const NOTIFICATION_TYPES = {
  FOOD_ORDER_READY: {
    event:      'food:order_ready',
    icon:       '🍽️',
    title:      'Food Order Ready',
    severity:   'success',
    recipients: ['ADMIN', 'SUPER_ADMIN', 'RECEPTIONIST'],
    // Stable id → the same order becoming READY can only ever notify once.
    buildId: (p) => (p && p.order_id ? `FOOD_ORDER_READY:${p.order_id}` : null),
    buildMessage: (p) => `${p.order_number || p.order_id} is ready.`,
    buildLines: (p) => {
      const lines = [];
      if (Array.isArray(p.items) && p.items.length) {
        for (const it of p.items.slice(0, 4)) {
          lines.push(`${it.item_name} × ${it.quantity}`);
        }
        if (p.items.length > 4) lines.push(`+${p.items.length - 4} more`);
      }
      const dest = p.destination_type === 'ROOM'
        ? `Room ${p.room_number}${p.guest_name ? ` (${p.guest_name})` : ''}`
        : (p.table_name || p.staff_name || p.owner_name || 'Restaurant');
      lines.push(dest);
      return lines;
    },
    buildMetadata: (p) => ({
      orderId:         p.order_id,
      orderNumber:     p.order_number,
      destinationType: p.destination_type,
      roomNumber:      p.room_number || null,
      tableName:       p.table_name || null,
      waiterName:      p.waiter_name || null,
      guestName:       p.guest_name || null,
      items:           Array.isArray(p.items) ? p.items.map(i => ({ item_name: i.item_name, quantity: i.quantity })) : [],
      status:          'READY'
    }),
    navigation: { module: 'food', tab: 'kds' },
    // Lifecycle: once the SAME order is handed off for delivery, its READY
    // notification is removed (list + toast + persisted copy). Matched on the
    // stable order_id only — never on order number or message text.
    removeOn: {
      event: 'food:status_changed',
      matches: (payload, n) =>
        !!payload &&
        payload.new_status === 'OUT_FOR_DELIVERY' &&
        payload.order_id != null &&
        !!n.metadata &&
        String(n.metadata.orderId) === String(payload.order_id)
    }
  },

  // ── Inventory: a purchase request is waiting for a decision ────────────────
  INVENTORY_PURCHASE_REQUEST_PENDING: {
    event:    'inventory:purchase_request_submitted',
    icon:     '📝',
    title:    'Purchase Request Pending Approval',
    severity: 'warning',
    // `recipients` only decides who SUBSCRIBES. Because approvers are
    // configurable at runtime, every role that could ever be configured must
    // subscribe; the real per-event filter is `eligible` below, which reads
    // the approver list the server sends with each event.
    recipients: ['ADMIN', 'SUPER_ADMIN', 'RECEPTIONIST', 'CHEF', 'KITCHEN_HELPER', 'PANTRY_BOY', 'CLEANER'],
    /**
     * Config-driven targeting. The server sends approver_roles from
     * settings/inventory_pr_approval — the SAME document Phase C authorizes
     * against — so there is a single source of truth. A requester never
     * receives the approval notification for their own request, even when
     * their own role is an approver role.
     */
    eligible: (p, ctx) => {
      if (!p || !p.request_id) return false;
      const roles = Array.isArray(p.approver_roles) ? p.approver_roles : [];
      if (roles.length === 0) return false;
      if (!ctx.backendRole || !roles.includes(ctx.backendRole)) return false;
      if (p.requested_by_uid && ctx.uid && String(p.requested_by_uid) === String(ctx.uid)) return false;
      return true;
    },
    // Stable id → reconnects and repeated deliveries collapse onto one entry.
    buildId: (p) => (p && p.request_id ? `INVENTORY_PURCHASE_REQUEST_PENDING:${p.request_id}` : null),
    buildMessage: (p) => `${p.request_number || p.request_id} requires approval.`,
    buildLines: (p) => {
      const lines = [];
      if (p.requested_by_name) lines.push(`Raised by ${p.requested_by_name}`);
      const where = [p.department, p.location_name].filter(Boolean).join(' · ');
      if (where) lines.push(where);
      const count = Number(p.item_count) || 0;
      const value = Number(p.estimated_total) || 0;
      lines.push(`${count} item${count === 1 ? '' : 's'}${value > 0 ? ` · est. ₹${value.toLocaleString('en-IN')}` : ''}`);
      if (p.priority && p.priority !== 'NORMAL') lines.push(`Priority: ${p.priority}`);
      return lines;
    },
    buildMetadata: (p) => ({
      requestId:     p.request_id,
      requestNumber: p.request_number || null,
      department:    p.department || null,
      locationId:    p.location_id || null,
      priority:      p.priority || null,
      itemCount:     p.item_count ?? null,
      requestedBy:   p.requested_by_name || null,
      status:        'PENDING_APPROVAL'
    }),
    // Opens Inventory → Purchase Requests → THIS request's detail view.
    // State-only navigation (no window.location / pushState), so it behaves
    // identically in the browser and under Electron's file:// origin.
    buildNavigation: (p) => ({ module: 'inventory', tab: 'purchase-requests', requestId: p.request_id }),
    // Once ANY approver decides, the pending item retires itself.
    removeOn: {
      event: 'inventory:purchase_request_decided',
      matches: (payload, n) =>
        !!payload &&
        payload.request_id != null &&
        !!n.metadata &&
        String(n.metadata.requestId) === String(payload.request_id)
    }
  }

  // ── Future (NOT implemented / NOT emitted yet) ─────────────────────────────
  // HOUSEKEEPING_ROOM_CLEANED: {
  //   event:      'housekeeping:room_cleaned',
  //   icon:       '🧹',
  //   title:      'Room Cleaned',
  //   severity:   'info',
  //   recipients: ['ADMIN', 'SUPER_ADMIN', 'RECEPTIONIST'],
  //   buildId:       (p) => `HOUSEKEEPING_ROOM_CLEANED:${p.roomId}:${p.cleanedAt || ''}`,
  //   buildMessage:  (p) => `Room ${p.roomNumber} has been cleaned.`,
  //   buildLines:    (p) => (p.cleanerName ? [`By ${p.cleanerName}`] : []),
  //   buildMetadata: (p) => ({ roomId: p.roomId, roomNumber: p.roomNumber, cleanerName: p.cleanerName, status: p.status }),
  //   navigation:    { module: 'housekeeping' }
  // }
};

function loadStored(uid) {
  if (!uid) return [];
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${uid}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_NOTIFICATIONS) : [];
  } catch {
    return [];
  }
}

function saveStored(uid, list) {
  if (!uid) return;
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${uid}`, JSON.stringify(list.slice(0, MAX_NOTIFICATIONS)));
  } catch { /* storage unavailable — in-memory only */ }
}

export function NotificationProvider({ children }) {
  const authCtx = useContext(AdminAuthContext);
  const adminUser = authCtx?.adminUser || null;

  const uid = adminUser?.uid || adminUser?.username || null;
  const normalizedRole = getNormalizedRole(adminUser);
  // Same user, expressed in the backend's role vocabulary — used by
  // config-driven notification targeting (see `eligible` in the registry).
  const backendRole = getBackendNormalizedRole(adminUser);

  // Which registry entries this user should receive at all.
  const subscribedTypes = useMemo(() => {
    if (!normalizedRole) return [];
    return Object.entries(NOTIFICATION_TYPES)
      .filter(([, def]) => def.recipients.includes(normalizedRole))
      .map(([type, def]) => ({ type, ...def }));
  }, [normalizedRole]);

  const isRecipient = subscribedTypes.length > 0;

  const [notifications, setNotifications] = useState(() => loadStored(uid));
  const [toasts, setToasts] = useState([]);
  const [navigationIntent, setNavigationIntent] = useState(null);
  const [connected, setConnected] = useState(false);

  // Mirror of the notification ids currently held — consulted synchronously
  // inside socket handlers so two deliveries in the same tick can't both pass.
  const knownIdsRef = useRef(new Set());
  const toastTimersRef = useRef(new Map());
  // Live mirror of the list for use inside socket handlers (avoids side
  // effects inside state updater functions). Kept in sync by the persistence
  // effect below.
  const notificationsRef = useRef(notifications);

  // (Re)hydrate when the signed-in user changes.
  useEffect(() => {
    const stored = loadStored(uid);
    knownIdsRef.current = new Set(stored.map(n => n.id));
    setNotifications(stored);
    setToasts([]);
    setNavigationIntent(null);
  }, [uid]);

  // Persist on every change.
  useEffect(() => {
    saveStored(uid, notifications);
    notificationsRef.current = notifications;
  }, [uid, notifications]);

  const dismissToast = useCallback((id) => {
    const t = toastTimersRef.current.get(id);
    if (t) { clearTimeout(t); toastTimersRef.current.delete(id); }
    setToasts(prev => prev.filter(x => x.id !== id));
  }, []);

  const pushToast = useCallback((notification) => {
    setToasts(prev => (prev.some(t => t.id === notification.id) ? prev : [notification, ...prev].slice(0, 5)));
    const timer = setTimeout(() => dismissToast(notification.id), TOAST_AUTO_DISMISS_MS);
    toastTimersRef.current.set(notification.id, timer);
  }, [dismissToast]);

  // Core ingest: event payload → notification (deduped) → list + toast.
  const ingest = useCallback((def, payload) => {
    // Optional per-event recipient filter. Entries without one behave exactly
    // as before (static `recipients` only) — this is additive. Entries with
    // one use it for runtime-configurable targeting, e.g. the inventory
    // approver list, and to exclude the actor who caused the event.
    if (typeof def.eligible === 'function' && !def.eligible(payload, { uid, role: normalizedRole, backendRole })) {
      return;
    }
    const id = def.buildId(payload);
    if (!id) return;
    if (knownIdsRef.current.has(id)) return; // duplicate delivery / replay / re-render — ignore
    knownIdsRef.current.add(id);

    const notification = {
      id,
      type:      def.type,
      title:     def.title,
      icon:      def.icon,
      message:   def.buildMessage(payload),
      lines:     def.buildLines ? def.buildLines(payload) : [],
      timestamp: new Date().toISOString(),
      read:      false,
      severity:  def.severity || 'info',
      metadata:  def.buildMetadata ? def.buildMetadata(payload) : {},
      // Static `navigation` still works; `buildNavigation` lets an entry point
      // at the specific record the event refers to.
      navigation: def.buildNavigation ? def.buildNavigation(payload) : (def.navigation || null)
    };

    setNotifications(prev => [notification, ...prev].slice(0, MAX_NOTIFICATIONS));
    pushToast(notification);
  }, [pushToast, uid, normalizedRole, backendRole]);

  // Lifecycle removal: drop ONLY the notifications of `def.type` that match the
  // incoming payload (per def.removeOn.matches). Idempotent — a repeated or
  // already-applied event finds nothing and changes nothing. Unread count is
  // derived from the list, so it adjusts by exactly the removed unread items.
  // The persisted copy follows automatically via the persistence effect.
  // Ids stay in knownIdsRef so a late duplicate of the original event cannot
  // resurrect a removed notification.
  const removeMatching = useCallback((def, payload) => {
    const rule = def.removeOn;
    if (!rule || typeof rule.matches !== 'function') return;
    const targets = notificationsRef.current.filter(n => n.type === def.type && rule.matches(payload, n));
    if (targets.length === 0) return;
    const ids = new Set(targets.map(n => n.id));
    for (const id of ids) dismissToast(id);
    setNotifications(prev => (prev.some(n => ids.has(n.id)) ? prev.filter(n => !ids.has(n.id)) : prev));
  }, [dismissToast]);

  // Single socket for the whole app; listeners registered once per socket
  // lifetime (inside the effect), never per render.
  useEffect(() => {
    if (!isRecipient) {
      setConnected(false);
      return undefined;
    }

    const socket = io(SOCKET_URL);
    const handlers = [];

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    for (const def of subscribedTypes) {
      const handler = (payload) => ingest(def, payload);
      socket.on(def.event, handler);
      handlers.push([def.event, handler]);

      if (def.removeOn && def.removeOn.event) {
        const removeHandler = (payload) => removeMatching(def, payload);
        socket.on(def.removeOn.event, removeHandler);
        handlers.push([def.removeOn.event, removeHandler]);
      }
    }

    return () => {
      for (const [event, handler] of handlers) socket.off(event, handler);
      socket.off('connect');
      socket.off('disconnect');
      socket.disconnect();
      setConnected(false);
    };
  }, [isRecipient, subscribedTypes, ingest, removeMatching]);

  // Clear pending toast timers on unmount.
  useEffect(() => () => {
    for (const t of toastTimersRef.current.values()) clearTimeout(t);
    toastTimersRef.current.clear();
  }, []);

  const markRead = useCallback((id) => {
    setNotifications(prev => prev.map(n => (n.id === id && !n.read ? { ...n, read: true } : n)));
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications(prev => (prev.some(n => !n.read) ? prev.map(n => (n.read ? n : { ...n, read: true })) : prev));
  }, []);

  // Navigation intent: consumers (App.jsx / ReceptionPortal / FoodPOS) react to
  // `navigationIntent` and the last one to act clears it.
  const requestNavigation = useCallback((navigation) => {
    if (!navigation) return;
    setNavigationIntent({ ...navigation, nonce: Date.now() });
  }, []);

  const clearNavigationIntent = useCallback(() => setNavigationIntent(null), []);

  const openNotification = useCallback((notification) => {
    if (!notification) return;
    markRead(notification.id);
    dismissToast(notification.id);
    if (notification.navigation) requestNavigation(notification.navigation);
  }, [markRead, dismissToast, requestNavigation]);

  const unreadCount = useMemo(() => notifications.reduce((n, x) => (x.read ? n : n + 1), 0), [notifications]);

  const value = useMemo(() => ({
    isRecipient,
    connected,
    notifications,
    unreadCount,
    toasts,
    markRead,
    markAllRead,
    dismissToast,
    openNotification,
    navigationIntent,
    requestNavigation,
    clearNavigationIntent
  }), [isRecipient, connected, notifications, unreadCount, toasts, markRead, markAllRead, dismissToast, openNotification, navigationIntent, requestNavigation, clearNavigationIntent]);

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  return useContext(NotificationContext);
}
