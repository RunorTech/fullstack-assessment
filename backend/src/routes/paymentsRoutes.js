const express = require("express");
const ordersService = require("../services/ordersService");
const idempotencyMiddleware = require("../middleware/idempotency");

const router = express.Router();

// Register idempotencyMiddleware() to prevent double credit card charges on concurrent submission retries
router.post("/charge", idempotencyMiddleware(), async (req, res, next) => {
  try {
    const { orderId } = req.body;
    const idempotencyKey = req.header("Idempotency-Key");
    const result = await ordersService.chargeOrder({ orderId, idempotencyKey });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/webhook", async (req, res, next) => {
  try {
    const { providerEventId, orderId, eventType, payload } = req.body;
    const result = await ordersService.processPaymentWebhook({
      providerEventId,
      orderId,
      eventType,
      payload,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
