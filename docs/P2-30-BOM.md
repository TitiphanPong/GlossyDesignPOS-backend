# P2-30 — BOM / recipe-driven material consumption

## Authority

`Product` is the canonical material recipe owner. A product can define a product-level `recipe`, and a variant can override it with its own `recipe`. Each recipe component maps one canonical inventory `stockItemId` to a positive quantity and unit. When the recipe unit differs from the stock item's unit, `conversionFactor` is mandatory.

Variant recipe takes precedence when an order line has a canonical variant with a recipe. Otherwise the product-level recipe is used. Canonical product lines without a usable recipe fail visibly when production tries to start; stock is not silently guessed.

## Production-stage consumption rule

Automatic material issue happens exactly once when a Production Job transitions from `queued` to `producing`.

- `file_check` and `queued`: no automatic stock consumption.
- `queued -> producing`: issue all recipe materials for the order lines mapped to that Production Job.
- `producing -> quality_check -> ready -> delivered`: no second automatic recipe issue.
- Cutting, printing, lamination, outsourcing, and finishing that happen inside the current broad `producing` stage are therefore represented by the one recipe issue at entry to `producing`.
- Additional spoilage or waste discovered during/after production is a separate `waste` movement and requires manager/admin authority.
- Custom/ad-hoc order lines without a canonical `productId` have no catalog recipe authority and are not auto-issued. Any real stock impact for those lines must be recorded explicitly rather than inferred.

A Production Job with multiple sibling jobs on the same order must have explicit `orderLineIndexes` before automatic issue. This prevents one job from consuming material for another job's lines. A single job may omit the mapping and then owns all order lines for that order. The sibling-overlap check is repeated at the actual issue boundary so concurrently created Jobs cannot both consume the same mapped Order line.

After every referenced recipe and stock-unit conversion is validated, the Job atomically records `materialIssueStartedAt` before the first stock movement. From that point the Order-line mapping is immutable. If a later material issue fails (for example because another required Stock Item is insufficient), a retry uses the same locked mapping and the stable per-material idempotency keys replay already-issued movements instead of consuming them twice.

## Historical reconstruction

Every automatic issue is idempotent per `productionJobId + stockItemId` and records:

- `orderId`
- `orderNumber`
- `productionJobId`
- the human-readable reason
- `reasonMetadata.triggerStage = producing`
- `reasonMetadata.productionJobNumber`
- the mapped `orderLineIndexes`
- `reasonMetadata.recipeSnapshot`, containing the exact product/variant source, line quantity, recipe quantity/unit, conversion factor, stock unit, and issued quantity that produced that stock movement

The stock movement is the historical consumption record. Later Product/Variant recipe edits do not rewrite previous movements or their recipe snapshots. The snapshot is also part of the idempotency fingerprint, so retrying the same issue key with a different recipe snapshot fails rather than silently changing history.

From `materialIssueStartedAt` onward, the Production Job's order-line mapping must not be changed because it is part of the historical material issue authority. `materialIssuedAt` records successful completion of the automatic issue plan; a started-but-not-completed timestamp therefore remains explicit evidence that a retry may need to finish remaining idempotent issues.
