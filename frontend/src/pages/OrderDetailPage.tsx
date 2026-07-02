import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError, chargeOrder, getOrder } from "../api";
import type { Order } from "../types";

export default function OrderDetailPage() {
  const { id } = useParams();
  const [order, setOrder] = useState<Order | null>(null);
  const [paying, setPaying] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!id) return;
    // active flag tracks whether this specific component effect instance is active
    let active = true;
    // abortController holds the signal for active/pending fetches
    let abortController = new AbortController();

    const fetchOrder = async (controller: AbortController) => {
      try {
        const data = await getOrder(id, { signal: controller.signal });
        if (active) {
          setOrder(data);
        }
      } catch (err: any) {
        // Ignore aborted query errors logged in console
        if (err.name !== "AbortError") {
          console.error(err);
        }
      }
    };

    // Perform initial fetch
    fetchOrder(abortController);

    // Set up status polling interval to query order updates every 2 seconds
    const intervalId = setInterval(() => {
      // Abort previous/pending polling request before dispatching a new one
      abortController.abort();
      abortController = new AbortController();
      fetchOrder(abortController);
    }, 2000);

    // CRITICAL: Return cleanup routine to clear interval and abort pending requests
    // to prevent background memory leaks and out-of-order state updates when the component unmounts
    return () => {
      active = false;
      clearInterval(intervalId);
      abortController.abort();
    };
  }, [id]);

  if (!order) return <p>Loading order...</p>;

  async function pay() {
    if (paying) return;
    setPaying(true); // Disable the button to prevent double-submitting charge requests
    try {
      const result = await chargeOrder(order!.id, idempotencyKey);
      setOrder(result.order);
    } catch (err) {
      console.error(err);
      if (err instanceof ApiError) {
        setIdempotencyKey(crypto.randomUUID());
      }
    } finally {
      setPaying(false); // Enable the button again on completion/failure
    }
  }

  return (
    <div className="page">
      <h1>Order #{order.id}</h1>
      <p>
        Status: <span className={`status ${order.status}`}>{order.status}</span>
      </p>
      <p>Total: ${order.totalAmount}</p>

      <h2>Items</h2>
      <ul>
        {(order.items || []).map((item, idx) => (
          <li key={idx}>
            {item.name} x {item.quantity} @ ${item.unitPrice}
          </li>
        ))}
      </ul>

      <h2>Payments</h2>
      {(order.payments || []).length === 0 && <p>No payments yet.</p>}
      <ul>
        {(order.payments || []).map((p, idx) => (
          <li key={idx}>
            {p.status} - ${p.amount} ({p.providerTxnId})
          </li>
        ))}
      </ul>

      {order.status === "PENDING" && (
        <button className="primary" onClick={pay} disabled={paying}>
          {paying ? "Charging..." : "Pay now"}
        </button>
      )}
    </div>
  );
}
