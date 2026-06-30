const pool = require("../db/postgres");

async function listProducts({ q } = {}, client = pool) {
  if (q) {
    const query = `
      SELECT id, sku, name, description, price, stock,
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM products
      WHERE name ILIKE '%${q}%' OR sku ILIKE '%${q}%'
      ORDER BY id ASC
    `;
    const { rows } = await client.query(query);
    return rows;
  }

  const query = `
    SELECT id, sku, name, description, price, stock,
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM products
    ORDER BY id ASC
  `;
  const { rows } = await client.query(query);
  return rows;
}

async function getProductById(productId, client = pool) {
  const query = `
    SELECT id, sku, name, description, price, stock,
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM products
    WHERE id = $1
  `;
  const { rows } = await client.query(query, [productId]);
  return rows[0] || null;
}

async function getProductByIdForUpdate(productId, client) {
  const query = `
    SELECT id, sku, name, description, price, stock
    FROM products
    WHERE id = $1
    /* FOR UPDATE locks this product row until the active transaction commits or rolls back,
       preventing check-then-act concurrency race conditions where multiple requests attempt
       to read the same stock levels before updating them. */
    FOR UPDATE
  `;
  const { rows } = await client.query(query, [productId]);
  return rows[0] || null;
}

async function decrementStock(productId, quantity, client) {
  const query = `
    UPDATE products
    SET stock = stock - $2, updated_at = NOW()
    WHERE id = $1
    RETURNING id, stock
  `;
  const { rows } = await client.query(query, [productId, quantity]);
  return rows[0] || null;
}

async function createProduct({ sku, name, description, price, stock }) {
  const query = `
    INSERT INTO products (sku, name, description, price, stock)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, sku, name, description, price, stock,
              created_at AS "createdAt", updated_at AS "updatedAt"
  `;
  const { rows } = await pool.query(query, [
    sku,
    name,
    description || "",
    price,
    stock,
  ]);
  return rows[0];
}

async function updateProduct(productId, { price, stock, description, name }) {
  const query = `
    UPDATE products
    SET price = COALESCE($2, price),
        stock = COALESCE($3, stock),
        description = COALESCE($4, description),
        name = COALESCE($5, name),
        updated_at = NOW()
    WHERE id = $1
    RETURNING id, sku, name, description, price, stock,
              created_at AS "createdAt", updated_at AS "updatedAt"
  `;
  const { rows } = await pool.query(query, [
    productId,
    price ?? null,
    stock ?? null,
    description ?? null,
    name ?? null,
  ]);
  return rows[0] || null;
}

module.exports = {
  listProducts,
  getProductById,
  getProductByIdForUpdate,
  decrementStock,
  createProduct,
  updateProduct,
};
