import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import DOMPurify from "dompurify";
import { ApiError, createOrder, getProduct } from "../api";
import { useCart } from "../state/CartContext";
import type { Product } from "../types";

export default function ProductDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { add } = useCart();
  const [product, setProduct] = useState<Product | null>(null);
  const [quantity, setQuantity] = useState(1);
  // submitting state prevents multiple concurrent orders from being sent if button is clicked multiple times
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!id) return;
    // active flag and AbortController prevent race conditions where out-of-order network responses overwrite state
    let active = true;
    const controller = new AbortController();

    getProduct(id, { signal: controller.signal })
      .then((data) => {
        if (active) {
          setProduct(data);
        }
      })
      .catch((err) => {
        // Ignore aborted query errors logged in console
        if (err.name !== "AbortError") {
          console.error(err);
        }
      });

    // Cleanup aborts pending fetch requests and flags this effect instance as inactive
    return () => {
      active = false;
      controller.abort();
    };
  }, [id]);

  if (!product) return <p>Loading...</p>;

  async function buyNow() {
    if (!product || submitting) return;
    setSubmitting(true); // Disable double submit triggers
    try {
      const order = await createOrder({
        customerId: "customer_001",
        items: [{ productId: product.id, quantity }],
        totalAmount: parseFloat(product.price) * quantity,
      }, idempotencyKey);
      navigate(`/orders/${order.id}`);
    } catch (err) {
      console.error(err);
      if (err instanceof ApiError) {
        setIdempotencyKey(crypto.randomUUID());
      }
      setSubmitting(false); // Reset submitting state on failure to allow retry
    }
  }

  return (
    <div className="page">
      <h1>{product.name}</h1>
      <p className="sku">{product.sku}</p>
      {/* DOMPurify.sanitize cleans product description to block Cross-Site Scripting (XSS) inputs */}
      <div
        className="description"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(product.description) }}
      />
      <p className="price">${product.price}</p>
      <p className="stock">
        {product.stock > 0 ? `${product.stock} in stock` : "Out of stock"}
      </p>
      <div className="qty-row">
        <input
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(Number(e.target.value))}
        />
      </div>
      <div className="actions">
        {/* Buttons are disabled during pending submissions to prevent accidental double-submits */}
        <button disabled={submitting} onClick={() => add(product, quantity)}>
          Add to cart
        </button>
        <button disabled={submitting || product.stock <= 0} onClick={buyNow} className="primary">
          {submitting ? "Processing..." : "Buy now"}
        </button>
      </div>
    </div>
  );
}
