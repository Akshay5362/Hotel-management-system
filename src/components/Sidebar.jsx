import React, { useContext } from 'react';
import { AdminAuthContext } from '../contexts/AdminAuthContext';
import { sidebarConfig } from '../config/sidebarConfig';

/**
 * Sidebar component for the Admin Dashboard.
 *
 * Props:
 *   activeTab    {string}    — current adminTab value; used to highlight the active item
 *   onTabChange  {function}  — called with a tab name when a tab-based item is clicked
 *   onAction     {function}  — called with an action name when a modal-based item is clicked
 *   onNavigate   {function}  — called with a path when a route-based item is clicked
 */
export default function Sidebar({ activeTab, activeModal, onTabChange, onAction, onNavigate }) {
  const { adminUser } = useContext(AdminAuthContext);

  if (!adminUser) return null;

  const role = adminUser.role || 'ADMIN';
  const menuItems = sidebarConfig[role] || sidebarConfig.ADMIN;

  const handleItemClick = (item) => {
    if (item.path) {
      // Full-page route navigation (cross-role dashboards)
      if (onNavigate) onNavigate(item.path);
    } else if (item.action) {
      // Opens a modal
      if (onAction) onAction(item.action);
    } else if (item.tab) {
      // In-page tab switch
      if (onTabChange) onTabChange(item.tab);
    }
  };

  const isActive = (item) => {
    if (item.tab)    return activeTab   === item.tab;
    if (item.action) return activeModal === item.action;
    return false;
  };

  return (
    <div className="sidebar-container">
      <div className="sidebar-header">
        Webline PMS <span>+</span>
      </div>
      <nav className="sidebar-menu">
        {menuItems.map((item, index) => (
          <button
            key={index}
            className={`sidebar-item${isActive(item) ? ' active' : ''}`}
            onClick={() => handleItemClick(item)}
            title={item.label}
            type="button"
          >
            <span className="sidebar-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
