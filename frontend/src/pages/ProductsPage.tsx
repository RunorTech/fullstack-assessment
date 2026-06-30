import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listProducts } from "../api";
import type { Product } from "../types";

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Flag to ignore network responses if a newer query has been dispatched
    let active = true;
    // AbortController to cancel stale search network requests immediately
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      try {
        const data = await listProducts(q, { signal: controller.signal });
        if (active) {
          setProducts(data);
        }
      } catch (err: any) {
        // Ignore aborted search errors logged in console
        if (err.name !== "AbortError") {
          console.error(err);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    load();

    // Cleanup aborts pending fetch requests and flags this hook instance as inactive on dependency update or unmount
    return () => {
      active = false;
      controller.abort();
    };
  }, [q]);

  return (
    <div className="page">
      <h1>Products</h1>
      <div className="toolbar">
        <input
          type="text"
          value={q}
          placeholder="Search products"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {loading && <p>Loading...</p>}
      <ul className="product-grid">
        {products.map((p, idx) => (
          <li key={idx} className="product-card">
            <Link to={`/products/${p.id}`}>
              <h3>{p.name}</h3>
              <p className="sku">{p.sku}</p>
              <p className="price">${p.price}</p>
              <p className="stock">
                {p.stock > 0 ? `${p.stock} in stock` : "Out of stock"}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
