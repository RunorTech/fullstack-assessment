const ordersService = require("./ordersService");
const productsRepository = require("../repositories/productsRepository");
const db = require("../db/postgres");
const redis = require("../db/redis");

describe("ordersService - Concurrency and Transaction Integrity", () => {
  let product1;
  let product2;

  beforeEach(async () => {
    // Clear test data and insert fresh products for each test
    await db.query("DELETE FROM order_items");
    await db.query("DELETE FROM orders");
    await db.query("DELETE FROM products");

    product1 = await productsRepository.createProduct({
      sku: "TEST-PROD-1",
      name: "Concurrency Book",
      price: 15.00,
      stock: 1,
    });

    product2 = await productsRepository.createProduct({
      sku: "TEST-PROD-2",
      name: "Transaction Mug",
      price: 10.00,
      stock: 5,
    });
  });

  afterAll(async () => {
    // Clean up connections so Jest exits cleanly
    await db.end();
    await redis.quit();
  });

  it("should create an order successfully and decrement stock when stock is sufficient", async () => {
    const order = await ordersService.createOrder({
      customerId: "cust_123",
      items: [{ productId: product2.id, quantity: 2 }],
      totalAmount: 20.00,
    });

    expect(order).toBeDefined();
    expect(order.id).toBeDefined();

    // Verify stock was decremented correctly
    const updatedProd2 = await productsRepository.getProductById(product2.id);
    expect(updatedProd2.stock).toBe(3);
  });

  it("should fail and rollback completely if one item in the order has insufficient stock", async () => {
    // Attempting to buy 1 Concurrency Book (stock = 1) and 6 Transaction Mugs (stock = 5)
    await expect(
      ordersService.createOrder({
        customerId: "cust_123",
        items: [
          { productId: product1.id, quantity: 1 },
          { productId: product2.id, quantity: 6 },
        ],
        totalAmount: 75.00,
      })
    ).rejects.toThrow(/Insufficient stock/);

    // Verify that BOTH product stocks remained unchanged (rollback succeeded)
    const updatedProd1 = await productsRepository.getProductById(product1.id);
    const updatedProd2 = await productsRepository.getProductById(product2.id);

    expect(updatedProd1.stock).toBe(1);
    expect(updatedProd2.stock).toBe(5);

    // Verify no orders were created
    const { rows } = await db.query("SELECT COUNT(*) FROM orders");
    expect(rows[0].count).toBe("0");
  });

  it("should prevent overselling under high concurrency (Check-Then-Act race condition)", async () => {
    const concurrencyCount = 10;
    const checkoutPromises = [];

    // Attempt to buy the last remaining Concurrency Book (stock = 1) 10 times concurrently
    for (let i = 0; i < concurrencyCount; i++) {
      checkoutPromises.push(
        ordersService.createOrder({
          customerId: `cust_concurrent_${i}`,
          items: [{ productId: product1.id, quantity: 1 }],
          totalAmount: 15.00,
        })
      );
    }

    const results = await Promise.allSettled(checkoutPromises);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly 1 checkout should succeed, and 9 should fail
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(concurrencyCount - 1);

    // All rejected promises should fail with a 409 conflict error (Insufficient stock)
    rejected.forEach((r) => {
      expect(r.reason.status).toBe(409);
      expect(r.reason.message).toContain("Insufficient stock");
    });

    // Stock must be exactly 0 (no negative values)
    const finalProduct1 = await productsRepository.getProductById(product1.id);
    expect(finalProduct1.stock).toBe(0);

    // Exactly 1 order record must be present in the database
    const { rows } = await db.query("SELECT COUNT(*) FROM orders");
    expect(rows[0].count).toBe("1");
  });

  it("should prevent deadlocks by sorting product IDs before acquiring locks", async () => {
    // Reset stock of product1 and product2
    await productsRepository.updateProduct(product1.id, { stock: 5 });
    await productsRepository.updateProduct(product2.id, { stock: 5 });

    // Fire two concurrent requests that lock the same resources in opposite input orders
    const request1 = ordersService.createOrder({
      customerId: "cust_deadlock_1",
      items: [
        { productId: product1.id, quantity: 1 },
        { productId: product2.id, quantity: 1 },
      ],
      totalAmount: 25.00,
    });

    const request2 = ordersService.createOrder({
      customerId: "cust_deadlock_2",
      items: [
        { productId: product2.id, quantity: 1 },
        { productId: product1.id, quantity: 1 },
      ],
      totalAmount: 25.00,
    });

    // They should complete successfully and not hang/deadlock
    const results = await Promise.all([request1, request2]);
    expect(results[0]).toBeDefined();
    expect(results[1]).toBeDefined();

    // Both orders should be created and stock decremented accordingly
    const finalProd1 = await productsRepository.getProductById(product1.id);
    const finalProd2 = await productsRepository.getProductById(product2.id);

    expect(finalProd1.stock).toBe(3);
    expect(finalProd2.stock).toBe(3);
  });
});
