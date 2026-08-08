/**
 * Migration 007: Create Inventory Categories and Products Tables
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1 Inventory Foundation & Product Master.
 * Creates `inventory_categories` and `inventory_products` tables.
 * Seeds standard hotel inventory categories.
 * Safe and non-destructive to all existing hotel PMS tables.
 */

export async function up(connection) {
  console.log('  Running migration 007_create_inventory_tables...');

  // 1. Create inventory_categories table
  await connection.query(`
    CREATE TABLE IF NOT EXISTS \`inventory_categories\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`name\` VARCHAR(100) UNIQUE NOT NULL,
      \`department\` VARCHAR(100) NOT NULL DEFAULT 'General',
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Seed default categories if empty
  const [existingCats] = await connection.query('SELECT COUNT(*) as count FROM `inventory_categories`');
  if (existingCats[0].count === 0) {
    const seedCategories = [
      ['Grocery', 'Kitchen'],
      ['Vegetables', 'Kitchen'],
      ['Fruits', 'Kitchen'],
      ['Dairy', 'Kitchen'],
      ['Beverages', 'Pantry'],
      ['Cleaning', 'Housekeeping'],
      ['Maintenance', 'Maintenance'],
      ['Pantry', 'Pantry'],
      ['Linen', 'Housekeeping'],
      ['Other', 'General']
    ];

    for (const [name, dept] of seedCategories) {
      await connection.query(
        'INSERT IGNORE INTO `inventory_categories` (`name`, `department`) VALUES (?, ?)',
        [name, dept]
      );
    }
  }

  // 2. Create inventory_products table
  await connection.query(`
    CREATE TABLE IF NOT EXISTS \`inventory_products\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`sku\` VARCHAR(50) UNIQUE NOT NULL,
      \`name\` VARCHAR(255) NOT NULL,
      \`category_id\` INT NOT NULL,
      \`unit_of_measure\` VARCHAR(20) NOT NULL,
      \`minimum_stock_level\` DECIMAL(10,2) DEFAULT 0.00,
      \`current_stock\` DECIMAL(10,2) DEFAULT 0.00,
      \`unit_price\` DECIMAL(10,2) DEFAULT 0.00,
      \`photo_url\` VARCHAR(255) DEFAULT NULL,
      \`status\` ENUM('Active', 'Inactive') DEFAULT 'Active',
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (\`category_id\`) REFERENCES \`inventory_categories\`(\`id\`) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  console.log('  ✓ Tables `inventory_categories` and `inventory_products` created successfully.');
}

export async function down(connection) {
  console.log('  Rolling back migration 007_create_inventory_tables...');
  await connection.query(`DROP TABLE IF EXISTS \`inventory_products\`;`);
  await connection.query(`DROP TABLE IF EXISTS \`inventory_categories\`;`);
  console.log('  ✓ Inventory tables dropped.');
}
