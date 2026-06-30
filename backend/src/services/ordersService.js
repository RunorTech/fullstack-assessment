const ordersRepository = require("../repositories/ordersRepository");
const productsRepository = require("../repositories/productsRepository");
const paymentsRepository = require("../repositories/paymentsRepository");
const paymentGateway = require("./paymentGateway");
const redis = require("../db/redis");
const db = require("../db/postgres");

// Helper transaction wrapper to acquire a connection from the PG pool,
// execute a callback inside a BEGIN/COMMIT block, and ROLLBACK in case of error.
// The transaction client is passed to the repositories to ensure all queries
// are executed inside the same atomic database transaction.
async function withTransaction(callback) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function createOrder({ customerId, items, totalAmount }) {
  if (!customerId || !Array.isArray(items) || items.length === 0) {
    const error = new Error("customerId and items are required");
    error.status = 400;
    throw error;
  }

  // CRITICAL CONCURRENCY SAFEGUARD:
  // Sort the requested order items by productId in ascending order.
  // This guarantees that all concurrent transactions acquire row locks in the exact same
  // sequence, preventing database deadlocks where transaction A locks product 1 and waits for 2,
  // while transaction B locks product 2 and waits for 1.
  const sortedItems = [...items].sort((a, b) => Number(a.productId) - Number(b.productId));

  // Run the checkout process inside an isolated database transaction
  return await withTransaction(async (client) => {
    const enrichedItems = [];
    
    // Phase 1: Verify all products and lock the records to read/hold their current stock levels
    for (const item of sortedItems) {
      // getProductByIdForUpdate runs a SELECT ... FOR UPDATE query within the transaction,
      // blocking concurrent checkout threads from acquiring the same products until this transaction commits.
      const product = await productsRepository.getProductByIdForUpdate(item.productId, client);
      if (!product) {
        const error = new Error(`Product ${item.productId} not found`);
        error.status = 404;
        throw error;
      }
      
      // Since the product stock row is locked, this check represents the final, authoritative
      // stock check. No other checkout request can change this stock value until we commit.
      if (product.stock < item.quantity) {
        const error = new Error(`Insufficient stock for ${product.name}`);
        error.status = 409;
        throw error;
      }
      enrichedItems.push({
        productId: product.id,
        quantity: item.quantity,
        unitPrice: Number(product.price),
      });
    }

    // Phase 2: Decrement product stocks safely within the transaction
    for (const item of enrichedItems) {
      await productsRepository.decrementStock(
        item.productId,
        item.quantity,
        client,
      );
    }

    // Phase 3: Create the order records referencing the active transaction
    const order = await ordersRepository.createOrder({
      customerId,
      totalAmount: Number(totalAmount),
      items: enrichedItems,
    }, client);

    return order;
  });
}

async function chargeOrder({ orderId, idempotencyKey }) {
  if (idempotencyKey) {
    const cached = await redis.get(`idem:${idempotencyKey}`);
    if (cached) {
      return JSON.parse(cached);
    }
  }

  const order = await ordersRepository.getOrderById(orderId);
  if (!order) {
    const error = new Error("Order not found");
    error.status = 404;
    throw error;
  }

  if (order.status !== "PENDING") {
    const error = new Error("Only pending orders can be charged");
    error.status = 409;
    throw error;
  }

  const gatewayResponse = await paymentGateway.charge({
    orderId: order.id,
    amount: order.totalAmount,
  });

  const payment = await paymentsRepository.createPayment({
    orderId: order.id,
    amount: gatewayResponse.chargedAmount,
    providerTxnId: gatewayResponse.providerTxnId,
    status: "SUCCESS",
    idempotencyKey,
  });

  const updatedOrder = await ordersRepository.markOrderAsPaid(order.id);

  if (idempotencyKey) {
    await redis.set(
      `idem:${idempotencyKey}`,
      JSON.stringify({ order: updatedOrder, payment }),
      "EX",
      3600,
    );
  }

  return { order: updatedOrder, payment };
}

async function processPaymentWebhook({
  providerEventId,
  orderId,
  eventType,
  payload,
}) {
  await paymentsRepository.createWebhookEvent({
    providerEventId,
    orderId,
    eventType,
    payload,
  });

  if (eventType === "payment_succeeded") {
    await ordersRepository.markOrderAsPaid(orderId);
  }

  return { accepted: true };
}

async function getOrderById(orderId) {
  const order = await ordersRepository.getOrderWithDetails(orderId);
  if (!order) {
    const error = new Error("Order not found");
    error.status = 404;
    throw error;
  }
  return order;
}

async function listOrders(params) {
  return ordersRepository.listOrders(params);
}

module.exports = {
  createOrder,
  chargeOrder,
  processPaymentWebhook,
  getOrderById,
  listOrders,
};
