import type { Order, Product } from "./types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { headers, ...restInit } = init;
  const res = await fetch(`${API_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(headers as Record<string, string> || {}),
    },
    ...restInit,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data?.error || res.statusText, res.status);
  }
  return data as T;
}

// Added optional init?: RequestInit parameter to support passing AbortSignal for request cancellation
export function listProducts(q?: string, init?: RequestInit): Promise<Product[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  return request<Product[]>(`/products${qs}`, init);
}

// Added optional init?: RequestInit parameter to support AbortSignal to prevent race conditions on fast page switching
export function getProduct(id: number | string, init?: RequestInit): Promise<Product> {
  return request<Product>(`/products/${id}`, init);
}

export function createOrder(
  body: {
    customerId: string;
    items: { productId: number; quantity: number }[];
    totalAmount: number;
  },
  idempotencyKey?: string,
): Promise<Order> {
  const headers: Record<string, string> = {};
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  return request<Order>("/orders", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// Added optional init?: RequestInit parameter to allow aborting of polling status checks during unmounts
export function getOrder(id: number | string, init?: RequestInit): Promise<Order> {
  return request<Order>(`/orders/${id}`, init);
}

export function chargeOrder(orderId: number, idempotencyKey?: string): Promise<{ order: Order }> {
  const headers: Record<string, string> = {};
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  return request<{ order: Order }>(`/payments/charge`, {
    method: "POST",
    headers,
    body: JSON.stringify({ orderId }),
  });
}

export function listOrdersAdmin(): Promise<Order[]> {
  return request<Order[]>(`/orders`);
}

export function updateProductAdmin(
  id: number,
  body: { price?: number; stock?: number; description?: string; name?: string },
): Promise<Product> {
  const token =
    localStorage.getItem("admin_token") ??
    import.meta.env.VITE_ADMIN_TOKEN ??
    "";
  return request<Product>(`/admin/products/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}
