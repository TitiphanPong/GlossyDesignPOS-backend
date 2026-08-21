# AUD-P0-01 financial create contract

New orders accept catalog identity, quantity, explicit price overrides, discount intent and initial-payment facts. Caller-authored line totals, aggregate totals and financial status are rejected by the global whitelist validation.

Catalog prices are available to every authenticated order creator. A `priceOverride` or custom line is accepted only when the authenticated actor is a `manager` or `admin`; staff requests receive 403.

```json
{
  "orderType": "QUICK_SALE",
  "cart": [
    { "productId": "...", "variantId": "...", "quantity": 2 },
    {
      "customName": "Approved custom work",
      "quantity": 1,
      "priceOverride": { "unitPrice": 250, "reason": "approved quote Q-100" }
    }
  ],
  "discount": { "type": "percent", "value": 10 },
  "initialPayment": { "amount": 100, "method": "cash", "receivedAmount": 120 },
  "taxInvoice": "no"
}
```

The backend snapshots catalog descriptions/prices, performs integer-satang arithmetic, and applies the discount before any tax. A regular receipt (`taxInvoice: "no"`) has zero VAT and keeps the discounted total unchanged. A tax invoice (`taxInvoice: "yes"`) adds VAT 7% to the VAT-exclusive discounted total. The backend derives `subtotal`, `discount`, `vatAmount`, `grandTotal`, `paidAmount`, `remainingTotal`, `changeAmount` and `status`.

## Reconciliation and migration plan

No database migration or destructive schema change is included. Existing orders remain byte-for-byte unchanged. The read-only command below consumes an approved JSON export and never opens a database connection:

```text
npm run reconcile:orders -- --input orders-export.json --output reconciliation.json
```

Before any later data rewrite: take an immutable snapshot; run and sign off the report; separate deterministic fixes from manual review; test a representative rollback sample; apply bounded conditional batches to a non-production copy; rerun the report; then schedule production only with owner approval, backup verification and a documented rollback window. Catalog prices cannot be reconstructed reliably from an order-only export, so the report marks that check `not_verified_from_export`.
