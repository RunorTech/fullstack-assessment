# Findings

This document lists the findings discovered during the security, concurrency, and reliability audit of both the backend and frontend systems.

---

## Backend

### Issue: Checkout Inventory Race Condition (Overselling)

- **Where**: `backend/src/services/ordersService.js` (inside `createOrder`) and `backend/src/repositories/productsRepository.js` (inside `getProductByIdForUpdate`).
- **Why**: The application checked product stock levels and updated them using separate SQL queries without proper isolation or locking. This allowed concurrent transactions to read the same stock value and decrement it simultaneously.
- **Impact**: Database stock drifted into negative values, leading to product overselling.
- **Fix**: Wrapped the database checks and decrements in an explicit transaction (`withTransaction`) and used pessimistic row-level locking (`SELECT ... FOR UPDATE`). We also sort request items by `productId` ascending to prevent concurrent lock deadlocks.
- **Trade-Offs**: Pessimistic locks serialize concurrent checkout transactions on the same product. This increases request queue times for popular "hot" items, but guarantees inventory integrity.

### Issue: Double Charging and Order Duplication on Retry

- **Where**: `backend/src/routes/ordersRoutes.js`, `backend/src/routes/paymentsRoutes.js`, and `backend/src/services/ordersService.js`.
- **Why**: The order creation and charging endpoints were not idempotent. They did not verify if incoming requests had been previously submitted and completed.
- **Impact**: Clients with weak connections retrying failed requests triggered multiple debit charges and generated duplicate order entries.
- **Fix**: Implemented a Redis-backed `Idempotency-Key` middleware. It uses atomic locks (`SET NX`) to prevent concurrent duplicate submissions, caches responses for 24h, and deletes the lock if a 5xx error or early connection close occurs.
- **Trade-Offs**: Adds an infrastructure dependency on Redis and consumes memory to cache full response objects for 24 hours.

### Issue: Unsecured Admin Endpoints (Authentication Bypass)

- **Where**: `backend/src/routes/adminRoutes.js` (endpoints `POST /admin/products` and `PATCH /admin/products/:id`).
- **Why**: The endpoints for creating and updating products were exposed without any authentication check, ignoring authorization headers.
- **Impact**: Any unauthenticated client or attacker could create new product listings or modify inventory and pricing details.
- **Fix**: Implemented `authMiddleware` in `backend/src/middleware/auth.js` to extract and validate Bearer tokens. Registered this middleware on the admin router to protect all admin endpoints.
- **Trade-Offs**: Requires client callers to correctly acquire and present authorization headers.

### Issue: Lack of Role-Based Access Control (RBAC)

- **Where**: `backend/src/middleware/auth.js` and `backend/src/routes/adminRoutes.js`.
- **Why**: Even when authenticated, there was no privilege separation. Any authenticated client had unrestricted access to both creating new products and updating existing listings.
- **Impact**: Non-administrative users or managers with limited credentials could bypass intent boundaries (e.g., creating products they are only supposed to update).
- **Fix**: Implemented Role-Based Access Control (RBAC) in `backend/src/middleware/auth.js`. Defined roles (`admin`, `manager`) and permissions (`products:create`, `products:update`). Applied `requirePermission` guards to individual route handlers so that `manager` is restricted only to editing products.
- **Trade-Offs**: Simple token-based RBAC requires secure management of different environment secrets (`ADMIN_TOKEN`, `MANAGER_TOKEN`).

---

## Frontend

### Issue: Cross-Site Scripting (XSS) in Product Details

- **Where**: `frontend/src/pages/ProductDetailPage.tsx` (rendering `product.description`).
- **Why**: Product descriptions retrieved from the API were rendered directly into the DOM using React's `dangerouslySetInnerHTML` without sanitization.
- **Impact**: Attackers with admin panel permissions could inject arbitrary malicious HTML/Script payloads that execute on client browsers.
- **Fix**: Integrated `dompurify` and sanitized the description HTML before rendering: `DOMPurify.sanitize(product.description)`.
- **Trade-Offs**: Negligible client-side rendering overhead during sanitization.

### Issue: Search State Race Condition

- **Where**: `frontend/src/pages/ProductsPage.tsx` (triggered by input search query).
- **Why**: Typing quickly fired multiple async search queries. Because they resolved out-of-order, older query results could overwrite newer ones if they took longer to resolve.
- **Impact**: Displayed products mismatched what was actually typed in the search bar.
- **Fix**: Moved search fetching logic to a reactive `useEffect` hook controlled by query state `q`, and abort pending requests using an `AbortController`.
- **Trade-Offs**: Aborted requests show up as canceled in network devtools, which is expected behavior.

### Issue: Status Polling memory leak

- **Where**: `frontend/src/pages/OrderDetailPage.tsx` (order status polling).
- **Why**: The status polling `setInterval` trigger was set up inside `useEffect` but never cleared upon component unmount.
- **Impact**: The browser kept querying the backend for status updates indefinitely, wasting memory and network bandwidth.
- **Fix**: Returned `clearInterval(intervalId)` inside the `useEffect` cleanup handler. Also integrated `AbortController` to cancel pending polling requests.
- **Trade-Offs**: None.

### Issue: Checkout and Payment Double-Submission

- **Where**: `ProductDetailPage.tsx` ("Buy now" button), `CartPage.tsx` ("Checkout" button), and `OrderDetailPage.tsx` ("Pay now" button).
- **Why**: Submit buttons remained active and interactive while API calls were pending.
- **Impact**: Users double-clicking buttons sent multiple order/payment requests.
- **Fix**: Implemented `submitting` / `paying` loading states to disable action buttons while processing requests.
- **Trade-Offs**: Minor UI state addition.
