const supertest = require("supertest");
const express = require("express");
const redis = require("../db/redis");
const db = require("../db/postgres");
const productsRepository = require("../repositories/productsRepository");
const idempotencyMiddleware = require("./idempotency");
const app = require("../app");

describe("Idempotency Middleware", () => {
  let dummyApp;
  let handlerCounter;
  let delayMs;
  let shouldFail;

  beforeAll(() => {
    // Setup a dummy express app to test the middleware in isolation
    dummyApp = express();
    dummyApp.use(express.json());

    handlerCounter = 0;
    delayMs = 0;
    shouldFail = false;

    dummyApp.post(
      "/test",
      idempotencyMiddleware(),
      async (req, res, next) => {
        handlerCounter++;
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        if (shouldFail) {
          return next(new Error("Simulated Server Error"));
        }
        res.status(201).json({ count: handlerCounter, data: req.body });
      }
    );

    // Basic error handler for dummy app
    dummyApp.use((err, req, res, next) => {
      res.status(500).json({ error: err.message });
    });
  });

  beforeEach(async () => {
    // Reset test parameters and clear redis/postgres
    handlerCounter = 0;
    delayMs = 0;
    shouldFail = false;
    
    // Clear Redis keys starting with idemp:
    const keys = await redis.keys("idemp:*");
    if (keys.length > 0) {
      await redis.del(keys);
    }
  });

  afterAll(async () => {
    // Clean up open connections
    await db.end();
    await redis.quit();
  });

  it("should bypass idempotency logic if header is not present", async () => {
    const res1 = await supertest(dummyApp).post("/test").send({ foo: "bar" });
    const res2 = await supertest(dummyApp).post("/test").send({ foo: "bar" });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.count).toBe(1);
    expect(res2.body.count).toBe(2);
    expect(res1.headers["x-cache-idempotency"]).toBeUndefined();
    expect(res2.headers["x-cache-idempotency"]).toBeUndefined();
  });

  it("should cache response and return HIT on second request with same key", async () => {
    const key = "test-key-1";
    const body = { foo: "bar" };

    const res1 = await supertest(dummyApp)
      .post("/test")
      .set("Idempotency-Key", key)
      .send(body);

    const res2 = await supertest(dummyApp)
      .post("/test")
      .set("Idempotency-Key", key)
      .send(body);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.count).toBe(1);
    expect(res2.body.count).toBe(1); // Cached count
    expect(res1.headers["x-cache-idempotency"]).toBeUndefined();
    expect(res2.headers["x-cache-idempotency"]).toBe("HIT");
    expect(res2.body.data).toEqual(body);
  });

  it("should release lock and allow subsequent requests if handler fails with 5xx", async () => {
    const key = "test-key-fail";
    shouldFail = true;

    const res1 = await supertest(dummyApp)
      .post("/test")
      .set("Idempotency-Key", key)
      .send({});

    expect(res1.status).toBe(500);

    // Second request should run again since lock was deleted (shouldFail is now false)
    shouldFail = false;
    const res2 = await supertest(dummyApp)
      .post("/test")
      .set("Idempotency-Key", key)
      .send({});

    expect(res2.status).toBe(201);
    expect(res2.body.count).toBe(2); // The handler runs again, so count increments to 2
  });

  it("should queue concurrent requests and resolve both to the same cached response", async () => {
    const key = "test-key-concurrent";
    delayMs = 300; // Delay handler so concurrent request is triggered

    const req1 = supertest(dummyApp)
      .post("/test")
      .set("Idempotency-Key", key)
      .send({ val: "A" });

    // Send the second request shortly after the first
    await new Promise((resolve) => setTimeout(resolve, 50));

    const req2 = supertest(dummyApp)
      .post("/test")
      .set("Idempotency-Key", key)
      .send({ val: "A" });

    const [res1, res2] = await Promise.all([req1, req2]);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    
    // Both should receive the first handler's output
    expect(res1.body.count).toBe(1);
    expect(res2.body.count).toBe(1);

    expect(res1.headers["x-cache-idempotency"]).toBeUndefined();
    expect(res2.headers["x-cache-idempotency"]).toBe("HIT");
  });

  it("should prevent duplicate order creation and stock double-decrement on /orders", async () => {
    // Clear databases
    await db.query("DELETE FROM order_items");
    await db.query("DELETE FROM orders");
    await db.query("DELETE FROM products");

    // Create a product
    const product = await productsRepository.createProduct({
      sku: "IDEMP-BOOK-1",
      name: "Idempotency Guide",
      price: 25.00,
      stock: 5,
    });

    const key = "order-idemp-key";
    const payload = {
      customerId: "customer_idemp",
      items: [{ productId: product.id, quantity: 2 }],
      totalAmount: 50.00,
    };

    // First request
    const res1 = await supertest(app)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send(payload);

    expect(res1.status).toBe(201);
    const orderId = res1.body.id;
    expect(orderId).toBeDefined();

    // Second request (retry)
    const res2 = await supertest(app)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send(payload);

    expect(res2.status).toBe(201);
    expect(res2.body.id).toBe(orderId);
    expect(res2.headers["x-cache-idempotency"]).toBe("HIT");

    // Verify stock is decremented ONLY ONCE (from 5 to 3)
    const finalProduct = await productsRepository.getProductById(product.id);
    expect(finalProduct.stock).toBe(3);

    // Verify only one order is in the DB
    const { rows } = await db.query("SELECT COUNT(*) FROM orders");
    expect(rows[0].count).toBe("1");
  });
});
