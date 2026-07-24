import { _electron as electron } from 'playwright';
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../../backend/db.js';

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
    const mainEntryPath = path.join(__dirname, '../../electron/main.js');
    console.log(`[E2E Setup] Launching Electron app from: ${mainEntryPath}`);
    
    electronApp = await electron.launch({
      args: [mainEntryPath],
      env: {
        ...process.env,
        NODE_ENV: 'production'
      }
    });

    // Pipe Electron process logs to test output for debugging
    electronApp.process().stdout.on('data', (data) => {
      console.log(`[Electron STDOUT] ${data.toString()}`);
    });
    electronApp.process().stderr.on('data', (data) => {
      console.error(`[Electron STDERR] ${data.toString()}`);
    });

    // Select the main window by polling until its title is initialized
    let found = null;
    for (let i = 0; i < 20; i++) {
      const windows = electronApp.windows();
      for (const win of windows) {
        try {
          const title = await win.title();
          if (title.includes('Webline PMS') || title.includes('HOTEL SKY-5')) {
            found = win;
            break;
          }
        } catch (e) {
          // Window might be transitioning or not ready
        }
      }
      if (found) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    if (!found) {
      const windows = electronApp.windows();
      window = windows[windows.length - 1] || await electronApp.firstWindow();
    } else {
      window = found;
    }
    
    // Log renderer console messages to CLI
    window.on('console', msg => console.log(`[Renderer CONSOLE] ${msg.text()}`));

    // Reset database to ensure tests are reproducible and clean
    try {
      console.log('[E2E Setup] Resetting database rooms and active bookings...');
      await pool.query("UPDATE rooms SET status = 'vacant', housekeeping_status = 'Clean'");
      await pool.query("DELETE FROM payments");
      await pool.query("DELETE FROM cash_logs");
      await pool.query("DELETE FROM ledger_items");
      await pool.query("DELETE FROM bookings");
      console.log('[E2E Setup] Database reset completed successfully.');
    } catch (e) {
      console.error('[E2E Setup] Failed to reset database:', e);
    }
  });

  // Terminate the Electron application container on completion
  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  // Test 1: Comprehensive Front-Desk Operations Workflow
  test('should authenticate staff user, check-in, room-shift, and check-out guest', async () => {
    // Assert window is visible and contains correct title
    await expect(window).toHaveTitle(/Webline PMS Plus/);

    // Clear local storage and navigate back to landing page to ensure a clean, reproducible test starting state
    await window.evaluate(() => localStorage.clear());
    const entryUrl = 'file://' + path.resolve(__dirname, '../../dist/index.html');
    await window.goto(entryUrl);

    // Assert window is visible and contains correct title
    await expect(window).toHaveTitle(/Webline PMS Plus/);

    // Wait for the landing page to load stably
    const staffCard = window.locator('text=Staff & Management');
    await expect(staffCard).toBeVisible({ timeout: 10000 });

    console.log('[E2E Test] Landing Page detected. Navigating to Staff Portal...');
    await staffCard.click();

    // Wait for staff portal login screen
    const loginInput = window.locator('input[placeholder="Enter username, email, or phone"]');
    await expect(loginInput).toBeVisible({ timeout: 10000 });

    // Enter staff credentials and submit form
    await window.fill('input[placeholder="Enter username, email, or phone"]', 'reception_morning');
    await window.fill('input[placeholder="Enter password"]', 'Reception@123');
    await window.click('button:has-text("Sign In")');

    // Wait for the "Logged in successfully!" notification modal and click OK
    const okButton = window.getByRole('button', { name: 'OK', exact: true });
    await expect(okButton).toBeVisible({ timeout: 5000 });
    await okButton.click();

    // Assert receptionist dashboard loads and displays rooms grid
    const dashboardGrid = window.locator('.rooms-grid');
    await expect(dashboardGrid).toBeVisible({ timeout: 10000 });
    await window.evaluate(() => document.body.classList.add('is-e2e-test'));
    console.log('[E2E Test] Authentication successful, dashboard loaded.');

    // ── 1. WALK-IN CHECK-IN (Room 1) ──
    const roomCard1 = window.locator('.room-card').filter({ has: window.locator('.room-number', { hasText: /^1$/ }) });
    await expect(roomCard1).toBeVisible();
    await roomCard1.locator('.room-number').click();

    // Verify Check-In Modal overlay is displayed
    const modalHeader = window.locator('.modal-header h3');
    await expect(modalHeader).toContainText('Room Check-In - Room 1');

    // Fill guest name, phone, and advance deposit amount
    await window.fill('input[placeholder="Enter guest\'s full name"]', 'E2E COMPREHENSIVE GUEST');
    await window.fill('input[type="tel"]', '+919999999999');
    
    // Clear and enter advance deposit
    const depositInput = window.locator('input[type="number"]');
    await depositInput.clear();
    await depositInput.fill('1000');

    // Submit check-in form
    await window.click('button:has-text("Confirm Check-In")', { force: true });

    // Verify that Check-in completes and modal closes
    await expect(modalHeader).not.toBeVisible();

    // Verify room status has updated to Occupied
    await expect(roomCard1).toHaveClass(/status-occupied/);
    console.log('[E2E Test] 1. Walk-in guest successfully checked into Room 1.');


    // Wait for React state updates to completely settle
    await window.waitForTimeout(1000);

    // ── 2. ROOM SHIFT (Room 1 -> Room 2) ──
    // Hover over Room 1 card to reveal the inline action buttons
    await roomCard1.hover();

    // Click the Shift action button
    const shiftButton = roomCard1.locator('button:has-text("Shift")');
    await expect(shiftButton).toBeVisible();
    await shiftButton.click();

    // Verify Room Shift Modal is displayed
    await expect(modalHeader).toContainText('Room Shift');

    // Select target Room 2 from the vacant room list
    const toRoomSelect = window.locator('select').nth(1);
    await toRoomSelect.selectOption('2');

    // Submit shift form
    await window.click('button:has-text("Confirm Shift")', { force: true });

    // Verify that Shift completes and modal closes
    await expect(modalHeader).not.toBeVisible();

    // Verify Room 1 has updated to Vacant, and Room 2 is now Occupied
    const roomCard2 = window.locator('.room-card').filter({ has: window.locator('.room-number', { hasText: /^2$/ }) });
    await expect(roomCard1).toHaveClass(/status-vacant/);
    await expect(roomCard2).toHaveClass(/status-occupied/);
    console.log('[E2E Test] 2. Guest successfully shifted from Room 1 to Room 2.');

    // Wait for React state updates to completely settle
    await window.waitForTimeout(1000);

    // ── 3. GUEST CHECK-OUT (Room 2) ──
    // Click on Room 2 to open the checkout modal
    await roomCard2.locator('.room-number').click();

    // Verify Checkout Modal overlay is displayed
    await expect(modalHeader).toContainText('Check-Out — Room 2');

    // Submit checkout form
    await window.click('button:has-text("Confirm Check-Out")', { force: true });

    // Verify that checkout completes and modal closes
    await expect(modalHeader).not.toBeVisible();

    // Verify Room 2 status has updated to Dirty
    await expect(roomCard2).toHaveClass(/status-dirty/);
    console.log('[E2E Test] 3. Guest successfully checked out of Room 2. Room is now dirty.');
  });
});
