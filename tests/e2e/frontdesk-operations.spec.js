import { _electron as electron } from 'playwright';
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * E2E UI Test Suite - Front Desk Operations
 * ---------------------------------------------------------------------------
 * This suite launches the Electron application container, logs in as an admin,
 * and performs frontend guest check-in simulations in the receptionist portal.
 */
test.describe('Webline PMS E2E Front-Desk Flow', () => {
  let electronApp;
  let window;

  // Launch the Electron process before E2E specs run
  test.beforeAll(async () => {
    const mainEntryPath = path.join(__dirname, '../../main.js');
    console.log(`[E2E Setup] Launching Electron app from: ${mainEntryPath}`);
    
    electronApp = await electron.launch({
      args: [mainEntryPath],
    });

    // Capture the main window context
    window = await electronApp.firstWindow();
  });

  // Terminate the Electron application container on completion
  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  // Test 1: Launch and Authentication Flow
  test('should launch application and authenticate staff user', async () => {
    // Assert window is visible and contains correct title
    await expect(window).toHaveTitle(/Webline PMS Plus/);

    // Enter staff credentials and submit form
    await window.fill('input[placeholder="Username"]', 'admin');
    await window.fill('input[placeholder="Password"]', 'admin123');
    await window.click('button:has-text("Login")');

    // Assert receptionist dashboard loads and displays rooms grid
    const dashboardGrid = window.locator('.rooms-grid');
    await expect(dashboardGrid).toBeVisible();
    console.log('[E2E Test] Authentication successful, dashboard loaded.');
  });

  // Test 2: Walk-In Guest Check-In Flow
  test('should open check-in modal and check-in walk-in guest with advance deposit', async () => {
    // Click on vacant Room card (Room 1)
    const roomCard = window.locator('.room-card:has-text("Room 1")');
    await expect(roomCard).toBeVisible();
    await roomCard.click();

    // Verify Check-In Modal overlay is displayed
    const modalHeader = window.locator('.modal-header h3');
    await expect(modalHeader).toContainText('Room Check-In - Room 1');

    // Fill guest name, phone, and advance deposit amount
    await window.fill('input[placeholder="Enter guest\'s full name"]', 'TEST GUEST');
    await window.fill('input[type="tel"]', '+919999999999');
    
    // Clear and enter advance deposit
    const depositInput = window.locator('input[type="number"]');
    await depositInput.clear();
    await depositInput.fill('1000');

    // Submit form
    await window.click('button:has-text("Confirm Check-In")');

    // Verify that Check-in completes and modal closes
    await expect(modalHeader).not.toBeVisible();

    // Verify room status has updated to Occupied (styled red or showing active guest)
    const activeRoomCard = window.locator('.room-card:has-text("Room 1")');
    await expect(activeRoomCard).toHaveClass(/occupied/);
    console.log('[E2E Test] Walk-in guest john doe successfully checked into Room 1.');
  });
});
