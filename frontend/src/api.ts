import type { Order, Product } from "./types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || res.statusText);
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

export function createOrder(body: {
  customerId: string;
  items: { productId: number; quantity: number }[];
  totalAmount: number;
}): Promise<Order> {
  return request<Order>("/orders", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// Added optional init?: RequestInit parameter to allow aborting of polling status checks during unmounts
export function getOrder(id: number | string, init?: RequestInit): Promise<Order> {
  return request<Order>(`/orders/${id}`, init);
}

export function chargeOrder(orderId: number): Promise<{ order: Order }> {
  return request<{ order: Order }>(`/payments/charge`, {
    method: "POST",
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
