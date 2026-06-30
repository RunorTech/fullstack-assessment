# AI Usage Notes

This document logs the AI usage, prompt history, validation strategies, and manual overrides applied during the security, concurrency, and reliability assessment of the application.

## 1. Tools used

- **Antigravity (model powered by Gemini)**: Primary AI coding agent.
- **Jest / Supertest**: Used for automated verification of concurrency and middleware layers.
- **TypeScript Compiler (`tsc`)**: Used for linting and build validation on the frontend.

## 2. Prompt journal

Here is the log of all prompts received and processed during this session, including what the model produced and the resolution.

### Prompt 1 (Backend Concurrency Race Conditions)

```
I am reviewing this backend code for an online storefront. I need to ensure it handles high-concurrency environments perfectly without overselling inventory or causing race conditions. 

Analyze this specific code block and identify any "Check-Then-Act" race conditions or database transaction isolation issues. If multiple users attempt to buy the last item at the exact same fraction of a second, what happens? 

Provide a high-integrity fix using PostgreSQL row-level locking (SELECT ... FOR UPDATE) or atomic SQL updates within an explicit transaction.
```

- **What it produced**: Concurrency analysis highlighting the vulnerability of running detached database reads and updates without transaction isolation. It proposed introducing `SELECT ... FOR UPDATE` query locking inside `productsRepository.js` and wrap checkout queries inside `ordersService.createOrder` in a transaction.
- **What was kept/rejected**: Kept all database locking and transaction wrapping code. I additionally sorted the item lines by `productId` ascending to prevent deadlocks when locking rows for concurrent orders containing the same items.

### Prompt 2 (Idempotency Middleware)

```
If a user has a weak internet connection, clicks "Place Order", times out, and their browser automatically retries the API request 2 seconds later, will this current backend architecture charge them twice or create duplicate orders? 

Look at this codebase. Help me design and implement an Idempotency-Key middleware using Redis. The middleware should check for an 'Idempotency-Key' header, cache incoming requests/responses, block simultaneous processing of identical keys, and safely return the cached response for retries. Show me how to safely integrate this into the order route.
```

- **What it produced**: Redis-backed Express middleware (`src/middleware/idempotency.js`) utilizing atomic Redis `SET NX` locks and response caching.
- **What was kept/rejected**: Kept the Redis `SET NX EX` structure and 24h caching mechanism. I rejected caching server-side errors (5xx status codes); if a server error occurs, the lock is deleted using `redis.del()` to permit immediate client retries.

### Prompt 3 (Frontend Security & UX Audit)

```
I am auditing this React/TypeScript component for security and UX flaws. 
1. Check if there are any Cross-Site Scripting (XSS) vulnerabilities where untrusted user input is rendered without sanitization.
2. Check for race conditions in React state if a user triggers multiple rapid API network requests (e.g., fast clicking pagination or filters before the previous fetch resolves).
3. Ensure the submission button is correctly disabled during pending states to prevent accidental double-submits on the UI layer.

Provide a production-ready refactor using DOMPurify for sanitization and an AbortController or clean-up flags for the fetching state.
```

- **What it produced**: Product page and detail hook updates using `AbortController` and `dompurify` HTML sanitizing.
- **What was kept/rejected**: Kept all changes. I manually updated the `OrderDetailPage` `useEffect` hook to clear the status polling interval (`clearInterval`) on unmount to fix a background memory leak.

### Prompt 4 (HTTP Concurrency Integration Test)

```
I need to write a high-impact integration test using Jest and Supertest to prove that my new inventory concurrency fix works. 

Write a test that seeds a product with exactly 1 item in stock. Then, use `Promise.all` to fire 5 concurrent, simultaneous HTTP requests to the checkout endpoint trying to buy that same item. 

The test must assert that exactly ONE request returns a 200/201 success status, that the other four requests fail with an appropriate conflict status (400 or 409), and that the final database stock count is exactly 0.
```

- **What it produced**: Supertest-based integration test targeting `POST /orders` concurrently under parallel execution blocks.
- **What was kept/rejected**: Kept the entire test logic and verified it runs successfully using the Jest runtime.

## 3. AI got it wrong

When requested to write a wallet balance transfer routine:

> "Write a quick TypeScript function for an Express route that handles transferring a balance or updating a user's wallet balance after a purchase. Make it clean and simple using an ORM pattern like a standard findOne followed by an update."

The model initially produced a standard check-then-act ORM routine:

```typescript
const user = await Wallet.findOne({ where: { userId } });
if (user.balance < amount) return res.status(400).send("Insufficient balance");
user.balance -= amount;
await user.save();
```

### Why it was wrong

This pattern contains a classic concurrency race condition. In a high-volume scenario, two concurrent requests can retrieve the same initial balance, bypass the conditional validation, and save overlapping results, causing double-spending and corrupting database state.

### Resolution

I intercepted the proposal and replaced it with a transaction-guarded query utilizing a pessimistic database write lock (`lock: transaction.LOCK.UPDATE`) or an atomic SQL execution statement (`UPDATE Wallet SET balance = balance - :amount WHERE userId = :userId AND balance >= :amount`).

---

## 4. Repository Changes Documented

Here is the log of all modifications made to the repository files during the assessment and the rationale behind each change.

### Backend Infrastructure

- **[docker-compose.yml](file:///home/kali/Desktop/Documents/BrandDrive/fullstack-assessment/docker-compose.yml)**: Remapped container port `5432` to host port `5433` to prevent conflicts with pre-existing system-wide Postgres instances.
- **[.env](file:///home/kali/Desktop/Documents/BrandDrive/fullstack-assessment/backend/.env)**: Modified `DATABASE_URL` to connect to Postgres via port `5433`.

### Backend Implementation

- **[productsRepository.js](file:///home/kali/Desktop/Documents/BrandDrive/fullstack-assessment/backend/src/repositories/productsRepository.js)**: Modified `getProductByIdForUpdate` to use `SELECT ... FOR UPDATE` row-level locking.
- **[ordersService.js](file:///home/kali/Desktop/Documents/BrandDrive/fullstack-assessment/backend/src/services/ordersService.js)**:
  - Added sorting to order items by `productId` to acquire row locks in ascending order, eliminating potential database transaction deadlocks.
  - Wrapped order queries within `withTransaction` blocks to guarantee atomicity.
- **[idempotency.js](file:///home/kali/Desktop/Documents/BrandDrive/fullstack-assessment/backend/src/middleware/idempotency.js)**: Created middleware to coordinate request locks and response cache using Redis.
- **[ordersRoutes.js](file:///home/kali/Desktop/Documents/BrandDrive/fullstack-assessment/backend/src/routes/ordersRoutes.js)**: Registered idempotency middleware on `POST /orders`.
- **[paymentsRoutes.js](file:///home/kali/Desktop/Documents/BrandDrive/fullstack-assessment/backend/src/routes/paymentsRoutes.js)**: Registered idempotency middleware on `POST /payments/charge`.

### Backend Tests

- **[ordersService.spec.js](file:///home/kali/Desktop/Documents/BrandDrive/fullstack-assessment/backend/src/services/ordersService.spec.js)**: Added service-level integration tests covering concurrency, transactional rollbacks, and deadlock scenarios.
- **[idempotency.spec.js](file:///home/kali/Desktop/Documents/BrandDrive/fullstack-assessment/backend/src/middleware/idempotency.spec.js)**: Added middleware verification tests checking cache hits, concurrent locks, and lock release hooks.
- **[ordersRoutes.spec.js](file:///home/kali/Desktop/Documents/BrandDrive/fullstack-assessment/backend/src/routes/ordersRoutes.spec.js)**: Added an integration test simulating 5 simultaneous client checkouts via Supertest, verifying only 1 succeeds.

### Frontend Implementation

- **[api.ts](file:///home/kali/Desktop/Documents/BrandDrive/fullstack-assessment/frontend/src/api.ts)**: Configured API routing calls (`listProducts`, `getProduct`, `getOrder`) to accept and forward `RequestInit` arguments (to support `AbortSignal`).
- **[ProductDetailPage.tsx](file:///home/kali/Desktop/Documents/BrandDrive/fullstack-assessment/frontend/src/pages/ProductDetailPage.tsx)**:
  - Sanitized product description HTML with `DOMPurify.sanitize()` before passing to `dangerouslySetInnerHTML`.
  - Added `AbortController` cleanup to `useEffect` to abort outdated requests.
  - Added a `submitting` state to disable action buttons.
- **[ProductsPage.tsx](file:///home/kali/Desktop/Documents/BrandDrive/fullstack-assessment/frontend/src/pages/ProductsPage.tsx)**: Made query updates trigger a reactive `useEffect` with `AbortController` support, eliminating search concurrency race conditions.
- **[OrderDetailPage.tsx](file:///home/kali/Desktop/Documents/BrandDrive/fullstack-assessment/frontend/src/pages/OrderDetailPage.tsx)**:
  - Cleared status polling interval on component unmount to prevent memory leaks.
  - Disabled "Pay now" button while `paying` is true.
  - Added `AbortController` integration for initial and periodic polling requests.
- **[CartPage.tsx](file:///home/kali/Desktop/Documents/BrandDrive/fullstack-assessment/frontend/src/pages/CartPage.tsx)**: Added `submitting` state to disable the "Checkout" button while checkout is in progress.

---

## 5. Validation strategy

- **Integration Tests**: Wrote `src/routes/ordersRoutes.spec.js` and `src/middleware/idempotency.spec.js` using `supertest` to fire concurrent HTTP requests concurrently using `Promise.all`.
- **Typing Checks**: Ran `npm run lint` (`tsc --noEmit`) in the frontend workspace to verify typings.
- **Manual Audits**: Hand-reviewed transactions, lock sequences, and cleanup handlers inside `useEffect` hook returns to prevent resource leaks.

---

## 6. What you did NOT delegate

1. **Lock Sequences (Deadlock Prevention)**: Handled the sorting sequence on bulk product locking in `ordersService.js` manually to ensure lock acquisition order is consistent across transactions.
2. **Resource Cleanup**: Ensured polling timers (`setInterval`) and active async request triggers are properly closed inside React hook cleanups.
3. **HTTP 5xx Error Release**: Explicitly coded the idempotency middleware to bypass response caching on server-side failures (5xx codes), preventing permanent cache locks on transient failures.
