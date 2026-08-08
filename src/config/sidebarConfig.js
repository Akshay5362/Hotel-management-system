/**
 * sidebarConfig.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Defines the sidebar navigation for each user role.
 *
 * Each item may have:
 *   label   — display text
 *   icon    — emoji icon
 *   tab     — adminTab value to set when clicked (in-page SPA navigation)
 *   action  — opens a modal instead of switching tab (e.g. 'reports', 'analytics')
 *   path    — external route (only for cross-page navigation like role dashboards)
 *
 * Navigation priority: path > action > tab
 */
export const sidebarConfig = {
  ADMIN: [
    { label: 'Dashboard',        icon: '📊', tab: 'frontdesk'    },
    { label: 'Rooms',            icon: '🛏️', tab: 'rooms'        },
    { label: 'Reservations',     icon: '📅', tab: 'reservations' },
    { label: 'Guests',           icon: '👥', tab: 'guests'       },
    { label: 'Housekeeping',     icon: '🧹', tab: 'housekeeping' },
    { label: 'Inventory',        icon: '📦', tab: 'inventory'    },
    { label: 'Reports',          icon: '📈', action: 'reports'   },
    { label: 'Analytics',        icon: '📉', action: 'analytics' },
    { label: 'Cash Management',  icon: '💰', action: 'cash'      },
    { label: 'Settings',         icon: '⚙️', action: 'settings'  },
  ],
  RECEPTIONIST: [
    { label: 'Dashboard',    icon: '📊', path: '/reception/dashboard' },
    { label: 'Front Office', icon: '🛎️', tab: 'frontdesk'            },
    { label: 'Check In',     icon: '🔑', action: 'checkin'            },
    { label: 'Check Out',    icon: '🧾', action: 'checkout'           },
    { label: 'Room Booking', icon: '📅', tab: 'reservations'          },
    { label: 'Guest Search', icon: '🔍', tab: 'guests'                },
    { label: 'Cash Handover',icon: '💸', action: 'cash'               },
    { label: 'Settings',     icon: '⚙️', action: 'settings'           },
  ],
  CHEF: [
    { label: 'Dashboard',      icon: '📊', path: '/kitchen/dashboard' },
    { label: 'Kitchen Orders', icon: '🍳', tab: 'kitchen'             },
    { label: 'Order History',  icon: '📜', tab: 'kitchen_history'     },
    { label: 'Settings',       icon: '⚙️', action: 'settings'         },
  ],
  PANTRY_BOY: [
    { label: 'Dashboard',       icon: '📊', path: '/pantry/dashboard' },
    { label: 'Pantry Orders',   icon: '☕', tab: 'pantry'             },
    { label: 'Beverage Orders', icon: '🍹', tab: 'pantry_beverages'   },
    { label: 'Settings',        icon: '⚙️', action: 'settings'         },
  ],
  CLEANER: [
    { label: 'Dashboard',            icon: '📊', path: '/housekeeping/dashboard' },
    { label: 'Assigned Rooms',       icon: '🛏️', tab: 'assigned_rooms'          },
    { label: 'Cleaning Tasks',       icon: '🧹', tab: 'cleaning_tasks'          },
    { label: 'Maintenance Requests', icon: '🔧', tab: 'maintenance'             },
    { label: 'Settings',             icon: '⚙️', action: 'settings'             },
  ],
};

// Lowercase aliases
sidebarConfig.admin = sidebarConfig.ADMIN;
