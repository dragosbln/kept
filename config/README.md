# Refund caps

`policy.example.json` is the built-in configuration written out as a
file: copy it, edit the amounts, and point the service at it.

```bash
cp config/policy.example.json config/policy.json
# in .env
KEPT_POLICY_CONFIG=config/policy.json
```

The file is read once at boot and validated against the policy engine's
schema. A file that does not parse stops the service from starting, with
the reason in the message. Its hash is stamped on every trace, every
policy decision and every ledger record, and printed in the boot log, so
an inbox screenshot can always be matched to the caps that were in
force. `version` is a label for humans; the hash is the fact.

## Shape

One entry per cap, per currency:

| Field              | Meaning                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `kind`             | `per_call`, `per_order`, `per_customer` or `per_day`                                                    |
| `amountMinorUnits` | The limit in the currency's minor units: `10000` is $100.00 or €100.00                                  |
| `currency`         | `USD` or `EUR`                                                                                          |
| `windowMs`         | Trailing window in milliseconds. Required for `per_customer` and `per_day`, forbidden for the other two |

The example uses a trailing 30 days for `per_customer` (`2592000000`)
and a trailing 24 hours for `per_day` (`86400000`).

## What the kinds mean

- `per_call`: one refund request on its own.
- `per_order`: everything refunded or pending on the order, plus this request.
- `per_customer`: everything refunded or pending for the customer across
  all their orders inside the window, plus this request.
- `per_day`: everything refunded or pending across the store inside the
  window, plus this request.

Pending and unknown refunds count toward every cap until a human denies
or settles them; failed and denied ones never do.

## Semantics worth knowing

- **Crossing a cap never denies.** It parks the refund for a human in the
  approval inbox. Deny is reserved for eligibility: undelivered items and
  lines already refunded.
- **Equal to the cap is allowed.** A request of exactly `amountMinorUnits`
  passes.
- **A cap of `0` means every refund needs a human.** Nothing is issued
  automatically in that currency.
- **A currency with no caps fails closed.** A refund in a currency the
  file does not mention goes to the inbox, with the reason
  `no_cap_for_currency`.
- **Amounts are never converted.** Each currency is its own set of caps
  and its own running totals.
- **Windows are trailing durations**, measured from the moment of the
  request, not calendar days in any timezone.
