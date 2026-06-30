const redis = require("../db/redis");

/**
 * Express middleware to enforce request idempotency using Redis.
 * This guarantees that retries on timed-out or failed network requests
 * do not double-process transactions (such as charges or order inserts).
 */
function idempotencyMiddleware() {
  return async (req, res, next) => {
    // 1. Inspect request for 'Idempotency-Key' header. If absent, bypass.
    const idempotencyKey = req.header("Idempotency-Key");
    if (!idempotencyKey) {
      return next();
    }

    // Prefixing to avoid namespace conflicts with other Redis components
    const redisKey = `idemp:req:${idempotencyKey}`;

    // Helper to query current state of the key in Redis
    const checkCache = async () => {
      const cachedStr = await redis.get(redisKey);
      if (!cachedStr) return null;
      
      const cached = JSON.parse(cachedStr);
      if (cached.status === "completed") {
        return cached; // Fully processed request response
      }
      if (cached.status === "processing") {
        return { status: "processing" }; // Lock is currently active
      }
      return null;
    };

    try {
      // 2. Try to acquire the processing lock atomically.
      // 'NX' ensures we only set the key if it doesn't exist.
      // 'EX' (60s) prevents permanent deadlocks if the server crashes mid-process.
      const acquired = await redis.set(
        redisKey,
        JSON.stringify({ status: "processing" }),
        "EX",
        60,
        "NX"
      );

      if (!acquired) {
        // 3. Lock not acquired: Either a duplicate request is processing or it has completed.
        const maxPollTimeMs = 5000;
        const intervalMs = 200;
        let elapsed = 0;

        // Poll Redis to wait for the concurrent request to complete
        while (elapsed < maxPollTimeMs) {
          const cached = await checkCache();
          if (cached) {
            if (cached.status === "completed") {
              // Cache HIT: Return the previously completed response immediately
              return res
                .status(cached.statusCode)
                .set("X-Cache-Idempotency", "HIT")
                .json(cached.body);
            }
            if (cached.status === "processing") {
              // Wait and poll again
              await new Promise((resolve) => setTimeout(resolve, intervalMs));
              elapsed += intervalMs;
              continue;
            }
          } else {
            // The lock was deleted because the other request failed. Try to acquire it ourselves.
            break;
          }
        }

        // If we timeout and the lock is still held, return 409 Conflict
        const cachedFinal = await checkCache();
        if (cachedFinal && cachedFinal.status === "processing") {
          return res.status(409).json({
            error: "Conflict",
            message: "A request with the same Idempotency-Key is currently in progress. Please try again shortly.",
          });
        }
        
        // Re-acquire lock if it was released by the previous failed worker
        const reacquired = await redis.set(
          redisKey,
          JSON.stringify({ status: "processing" }),
          "EX",
          60,
          "NX"
        );
        if (!reacquired) {
          return res.status(409).json({
            error: "Conflict",
            message: "A request with the same Idempotency-Key is currently in progress. Please try again shortly.",
          });
        }
      }

      // 4. We hold the lock. Intercept response hooks to store the completion payload.
      const originalJson = res.json;
      const originalSend = res.send;

      let responseSaved = false;

      const saveResponse = async (statusCode, body) => {
        if (responseSaved) return;
        responseSaved = true;
        try {
          if (statusCode >= 500) {
            // CRITICAL: Release the lock immediately on server failures so the client can retry.
            await redis.del(redisKey);
          } else {
            // Save successful/client-error responses for 24 hours
            await redis.set(
              redisKey,
              JSON.stringify({
                status: "completed",
                statusCode,
                body,
              }),
              "EX",
              86400
            );
          }
        } catch (err) {
          console.error("Failed to save/delete idempotency key in Redis", err);
        }
      };

      // Intercept res.json updates
      res.json = function (body) {
        saveResponse(res.statusCode, body);
        return originalJson.apply(this, arguments);
      };

      // Intercept res.send updates
      res.send = function (body) {
        let parsedBody = body;
        if (typeof body === "string") {
          try {
            parsedBody = JSON.parse(body);
          } catch (_) {
            // Keep as string
          }
        }
        saveResponse(res.statusCode, parsedBody);
        return originalSend.apply(this, arguments);
      };

      // 5. Clean up lock if request fails/aborts early
      res.on("close", async () => {
        if (!responseSaved) {
          try {
            await redis.del(redisKey);
          } catch (err) {
            console.error("Failed to release idempotency lock in Redis", err);
          }
        }
      });

      return next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = idempotencyMiddleware;
