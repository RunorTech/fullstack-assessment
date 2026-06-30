const supertest = require("supertest");
const app = require("../app");
const db = require("../db/postgres");
const redis = require("../db/redis");
const productsRepository = require("../repositories/productsRepository");

describe("Orders HTTP Concurrency Integration Tests", () => {
  let product;

  beforeEach(async () => {
    // Clean database before each test
    await db.query("DELETE FROM order_items");
    await db.query("DELETE FROM orders");
    await db.query("DELETE FROM products");

    // Seed a product with exactly 1 item in stock
    product = await productsRepository.createProduct({
      sku: "CONC-PROD-99",
      name: "Concurrent Hot Item",
      price: 99.99,
      stock: 1,
    });
  });

  afterAll(async () => {
    // Clean up connections so Jest exits cleanly
    await db.end();
    await redis.quit();
  });

  it("should handle 5 concurrent HTTP checkouts on 1 remaining stock item, allowing exactly 1 to succeed and 4 to fail with 409", async () => {
    const concurrentRequests = 5;
    const checkoutPromises = [];

    for (let i = 0; i < concurrentRequests; i++) {
      // Fire requests concurrently using different Idempotency-Keys
      checkoutPromises.push(
        supertest(app)
          .post("/orders")
          .set("Idempotency-Key", `conc-key-${i}`)
          .send({
            customerId: `customer_${i}`,
            items: [{ productId: product.id, quantity: 1 }],
            totalAmount: 99.99,
          })
      );
    }

    const responses = await Promise.all(checkoutPromises);

    const successful = responses.filter((r) => r.status === 201 || r.status === 200);
    const failed = responses.filter((r) => r.status === 409 || r.status === 400);

    // Assert that exactly one checkout was successful
    expect(successful.length).toBe(1);
    
    // Assert that the other four failed
    expect(failed.length).toBe(4);

    // Verify all failed responses have correct error message
    failed.forEach((res) => {
      expect(res.body.error).toContain("Insufficient stock");
    });

    // Assert final database stock count is exactly 0
    const finalProduct = await productsRepository.getProductById(product.id);
    expect(finalProduct.stock).toBe(0);

    // Verify that exactly 1 order exists in database
    const { rows } = await db.query("SELECT COUNT(*) FROM orders");
    expect(rows[0].count).toBe("1");
  });
});
