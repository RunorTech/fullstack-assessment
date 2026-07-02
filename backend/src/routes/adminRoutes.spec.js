const supertest = require("supertest");
const app = require("../app");
const db = require("../db/postgres");
const productsRepository = require("../repositories/productsRepository");

describe("Admin Routes Authentication & RBAC Integration Tests", () => {
  const adminToken = process.env.ADMIN_TOKEN || "8904b524a1d5871189ae55b5e96923921264eb700652d25f6d7e825e85bd5d74";
  const managerToken = process.env.MANAGER_TOKEN || "1a89b524a1d5871189ae55b5e96923921264eb700652d25f6d7e825e85bd5d74";
  let product;

  beforeEach(async () => {
    // Clean database before each test
    await db.query("DELETE FROM order_items");
    await db.query("DELETE FROM orders");
    await db.query("DELETE FROM products");

    // Seed a product for update tests
    product = await productsRepository.createProduct({
      sku: "TEST-PROD-01",
      name: "Test Product",
      price: 10.00,
      stock: 10,
    });
  });

  afterAll(async () => {
    // Clean up connections so Jest exits cleanly
    await db.end();
  });

  describe("POST /admin/products", () => {
    const newProductPayload = {
      sku: "NEW-PROD-99",
      name: "New Admin Product",
      price: 15.50,
      stock: 5,
    };

    it("should reject product creation with 401 if Authorization header is missing", async () => {
      const response = await supertest(app)
        .post("/admin/products")
        .send(newProductPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(response.body.message).toContain("missing or malformed");
    });

    it("should reject product creation with 401 if Authorization header is malformed", async () => {
      const response = await supertest(app)
        .post("/admin/products")
        .set("Authorization", "InvalidFormat token")
        .send(newProductPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
    });

    it("should reject product creation with 403 if token is incorrect", async () => {
      const response = await supertest(app)
        .post("/admin/products")
        .set("Authorization", "Bearer badtoken")
        .send(newProductPayload);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("Forbidden");
      expect(response.body.message).toContain("Invalid authentication token");
    });

    it("should reject product creation with 403 Forbidden if a manager token is provided", async () => {
      const response = await supertest(app)
        .post("/admin/products")
        .set("Authorization", `Bearer ${managerToken}`)
        .send(newProductPayload);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("Forbidden");
      expect(response.body.message).toContain("permission to perform this action");
    });

    it("should allow product creation with 201 if valid admin token is provided", async () => {
      const response = await supertest(app)
        .post("/admin/products")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(newProductPayload);

      expect(response.status).toBe(201);
      expect(response.body.sku).toBe(newProductPayload.sku);
      expect(response.body.name).toBe(newProductPayload.name);
    });
  });

  describe("PATCH /admin/products/:id", () => {
    const updatePayload = {
      price: 12.50,
      stock: 8,
    };

    it("should reject product update with 401 if Authorization header is missing", async () => {
      const response = await supertest(app)
        .patch(`/admin/products/${product.id}`)
        .send(updatePayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
    });

    it("should reject product update with 403 if token is incorrect", async () => {
      const response = await supertest(app)
        .patch(`/admin/products/${product.id}`)
        .set("Authorization", "Bearer badtoken")
        .send(updatePayload);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("Forbidden");
    });

    it("should allow product update with 200 if valid admin token is provided", async () => {
      const response = await supertest(app)
        .patch(`/admin/products/${product.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send(updatePayload);

      expect(response.status).toBe(200);
      expect(Number(response.body.price)).toBe(updatePayload.price);
      expect(response.body.stock).toBe(updatePayload.stock);
    });

    it("should allow product update with 200 if valid manager token is provided", async () => {
      const response = await supertest(app)
        .patch(`/admin/products/${product.id}`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send(updatePayload);

      expect(response.status).toBe(200);
      expect(Number(response.body.price)).toBe(updatePayload.price);
      expect(response.body.stock).toBe(updatePayload.stock);
    });
  });
});
