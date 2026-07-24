import fs from 'fs';
const lines = fs.readFileSync('src/index.css', 'utf8').split('\n');
const goodLines = lines.slice(0, 946);
const css = `
/* Sidebar Layout Additions */
.app-layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  min-height: 100vh;
}
.sidebar-container {
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-color);
  backdrop-filter: var(--glass-blur);
  display: flex;
  flex-direction: column;
}
.sidebar-header {
  height: var(--header-height);
  display: flex;
  align-items: center;
  padding: 0 1.5rem;
  border-bottom: 1px solid var(--border-color);
  font-family: var(--font-heading);
  font-weight: 700;
  font-size: 1.2rem;
  color: var(--text-main);
  letter-spacing: 1px;
}
.sidebar-header span {
  color: var(--color-vacant);
}
.sidebar-menu {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sidebar-item {
  display: flex;
  align-items: center;
  padding: 0.8rem 1.5rem;
  color: var(--text-secondary);
  text-decoration: none;
  transition: all 0.2s ease;
  cursor: pointer;
  border-left: 3px solid transparent;
  font-weight: 500;
}
.sidebar-item:hover, .sidebar-item.active {
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-main);
}
.sidebar-item:hover {
  border-left: 3px solid rgba(56, 189, 248, 0.5);
}
.sidebar-item.active {
  border-left: 3px solid var(--color-vacant);
  background: linear-gradient(90deg, rgba(56, 189, 248, 0.1) 0%, transparent 100%);
}
.sidebar-icon {
  margin-right: 14px;
  font-size: 1.25rem;
}
`;
fs.writeFileSync('src/index.css', goodLines.join('\n') + css);
console.log('Fixed index.css');
