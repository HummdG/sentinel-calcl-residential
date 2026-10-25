# Sentinel savings calculator API — v1

One endpoint. Send a household's usage, solar, battery, cost and tariff; get back year-1 bills
with and without battery optimisation, the savings breakdown, the energy the battery moves, a
25-year payback/ROI projection and, optionally, a comparison against the OpenSolar report.

| | |
|---|---|
| Endpoint | `POST /api/v1/calc` (add `?detail=true` for monthly bills) |
| Machine-readable spec | `GET /api/v1/openapi.json` (OpenAPI 3.1, no key needed) |
| Format | JSON in, JSON out, UTF-8 |
| Auth | `Authorization: Bearer <api key>` |
| Model version | `2026-10.1` (returned as `meta.config_version`) |

---

## 1. Authentication

Every call to `/api/v1/calc` needs an API key issued by HS Energy, sent as a bearer token:

```
Authorization: Bearer scalc_live_4hQ...Jd53
```

- **Keys are per client.** Each partner gets their own key, so one can be revoked without
  affecting anyone else. Keep it server-side — never ship it in a browser or mobile app.
- **Getting a key.** HS Energy runs `npm run api-key -- <client-id> "<Client name>" [rate_per_min]`.
  It prints the key once (hand it over securely) and a JSON entry containing only the key's
  SHA-256 hash, which is added to the `CALC_API_KEYS` environment variable in Vercel. The key
  itself is stored nowhere, so a lost key is replaced, not recovered.
- **Rotating.** Issue a new key, add its entry alongside the old one, let the client switch,
  then delete the old entry and redeploy.
- **Revoking.** Delete the client's entry from `CALC_API_KEYS` and redeploy.
- **Rate limit.** 60 requests per minute per key unless the entry sets `rate_per_min`. Over the
  limit you get `429` with a `Retry-After` header (seconds). The counter is kept per server
  instance, so treat it as a safety ceiling rather than an exact quota.

A missing, malformed or unknown key returns `401`:

```json
{
  "error": {
    "code": "unauthorized",
    "message": "Missing or invalid API key. Send Authorization: Bearer <key>.",
    "request_id": "813407df-5cd0-49d7-8b76-ddb147b8dc8f"
  }
}
```

---

## 2. Request

`POST /api/v1/calc` with a JSON object. Numbers must be JSON numbers — `"3500"` (a string) is
rejected, not converted. Optional fields may be left out or sent as `null`; either way the
default applies. Fields not listed here are ignored.

### Required

| Field | Unit | Rules | Used for |
|---|---|---|---|
| `annual_usage` | kWh/yr | > 0, ≤ 200,000 | Total household consumption |
| `annual_gen` | kWh/yr | ≥ 0, ≤ 200,000 | PV generation. `0` = no solar (valid) |
| `battery_kwh` | kWh (nameplate) | ≥ 0, ≤ 1,000 | Battery capacity. `0` = no battery (valid) |
| `inverter_kw` | kW | ≥ 0, ≤ 1,000 | Caps battery charging (solar and grid) and discharging in each half-hour. `0` = no battery (valid) |
| `system_cost` | £ | > 0, ≤ 10,000,000 | Payback, 25-year saving, ROI |

### Optional

| Field | Unit | Default | Rules | Used for |
|---|---|---|---|---|
| `tariff` | `flux` \| `go` \| `economy7` \| `flat` | `flux` | one of the four | Tariff for the self-use and optimised scenarios (see §6) |
| `usage` | `home_all_day` \| `half_day` \| `out_all_day` | `half_day` | one of the three | Occupancy: when in the day the household uses power |
| `self_use_fraction` | fraction | `0.35` | 0–1 | Share of PV the home uses directly before any battery, from the OpenSolar report |
| `std_import` | £/kWh | `0.26` | ≥ 0 | The no-system rate (the baseline every saving is measured against) and the `flat` tariff's rate |
| `dn_day` | £/kWh | `0.30` | ≥ 0 | Economy 7 day rate |
| `dn_night` | £/kWh | `0.15` | ≥ 0 | Economy 7 night (cheap) rate |
| `inflation` | % per year | `5` | −10 to 20 | Yearly growth of savings (`5` = 5%) |
| `export_limit_kw` | kW | `0` | ≥ 0 | DNO export cap on solar + battery export together. `0` = no limit |

### OpenSolar pass-through (comparison only)

These are **never used in the calculation**. Each one you send produces the matching
`comparison` field; leave them out and `comparison` is omitted.

| Field | Unit | Rules | Produces |
|---|---|---|---|
| `solar_savings` | £ (year 1) | any number | `comparison.solar_savings_diff` |
| `report_payback` | years | ≥ 0 | `comparison.payback_diff` |
| `report_25yr` | £ | any number | `comparison.saving_25yr_diff` |
| `report_roi` | ratio | any number | `comparison.roi_diff` (same definition as our `roi`: 25-year saving ÷ cost, so 2.17 = 217%) |

### Example

```bash
curl -X POST https://<host>/api/v1/calc \
  -H "Authorization: Bearer $SENTINEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "annual_usage": 3500, "annual_gen": 4000,
        "battery_kwh": 10, "inverter_kw": 5, "system_cost": 12000,
        "tariff": "flux", "usage": "half_day",
        "solar_savings": 700, "report_payback": 11.5, "report_25yr": 26000, "report_roi": 2.17
      }'
```

---

## 3. Response (`200`)

Money is in £ to 2 dp, energy in whole kWh per year, years to 2 dp, ratios to 3 dp. Every
response also carries an `X-Request-Id` header.

### `year1`

"Self-use" and "optimised" are both on the **selected tariff**; the baseline is the **same
household with no system on the standard rate**: `annual_usage × std_import`.

| Field | Meaning |
|---|---|
| `bill_self_use` | Year-1 bill with the battery charged **only from spare solar** and discharged into the home. No grid charging, no battery export. May be negative. |
| `bill_optimised` | Year-1 bill with the battery **optimised**: grid-charged in the cheap window, discharged at expensive times, and (on Flux) exporting at the peak export rate. May be negative. Never higher than `bill_self_use`. |
| `saving_total` | Baseline − `bill_optimised`. The headline saving. |
| `saving_tariff_and_solar` | Baseline − `bill_self_use`: the tariff switch plus solar, without optimisation. **Can be negative** (e.g. a battery-only home moving to Go, whose day rate is above the standard rate). |
| `saving_optimisation` | `bill_self_use − bill_optimised`. Never negative. |
| `optimisation_uplift` | `saving_optimisation ÷ saving_tariff_and_solar`. **`null` when `saving_tariff_and_solar` ≤ 0.** |
| `monthly_saving` | `saving_total ÷ 12` |
| `simple_payback_years` | `system_cost ÷ saving_total`, no inflation or degradation. **`null` when `saving_total` ≤ 0.** |

`saving_total = saving_tariff_and_solar + saving_optimisation` always holds.

### `energy` — optimised scenario, kWh per year

| Field | Meaning |
|---|---|
| `grid_import_outside_cheap_kwh` | Grid import outside the tariff's cheap window. On `flat` (no cheap window) this is all import. |
| `grid_charge_kwh` | Grid energy put into the battery (before losses). |
| `battery_export_kwh` | Battery energy exported to the grid. Only on `flux`, the one tariff whose export rate varies through the day. |
| `curtailed_kwh` | Solar lost because `export_limit_kw` was reached. Always 0 with no limit. *Not in the brief; added so the cost of an export cap is visible.* |

### `lifetime`

| Field | Meaning |
|---|---|
| `years[]` | 25 entries, year 1 first: `year` (1–25); `saving` = `saving_total × (1 + inflation)^(n−1) × (1 − degradation)^(n−1)`; `cumulative_saving`; `net_position` = `cumulative_saving − system_cost`. |
| `payback_years` | When `net_position` first reaches 0, interpolated within that year (8.5 = halfway through year 9). **`null` if not within 25 years, or if `saving_total` ≤ 0.** |
| `saving_25yr` | Sum of the 25 yearly savings. |
| `roi` | `saving_25yr ÷ system_cost` — OpenSolar's definition. |
| `net_roi` | `(saving_25yr − system_cost) ÷ system_cost`. |

Degradation is 0.5% a year (`meta.assumptions.degradation`).

### `comparison` (only when OpenSolar figures were sent)

Each field is **ours minus the report's**, present only if its input was sent. Positive = we
project more saving / a higher ROI; for `payback_diff`, negative = we pay back sooner.

| Field | Formula |
|---|---|
| `solar_savings_diff` | `saving_total − solar_savings` |
| `payback_diff` | `payback_years − report_payback`; `null` if our `payback_years` is `null` |
| `saving_25yr_diff` | `saving_25yr − report_25yr` |
| `roi_diff` | `roi − report_roi` |

### `meta`

| Field | Meaning |
|---|---|
| `tariff`, `usage` | The values used (defaults filled in). |
| `config_version` | Version of the model assumptions. It changes whenever a rate, profile or constant changes, so two results with the same inputs and version are directly comparable. |
| `assumptions` | What this result rests on, for audit: `bands` (each tariff band's clock-time window, import and export £/kWh, and whether it is the cheap window), `battery_usable_fraction`, `battery_round_trip_efficiency`, `degradation`, `inflation` (as a fraction), `self_use_fraction_applied` (see §6), and `standing_charges: "excluded"`. *Not in the brief; added for auditability.* |

### `monthly` (only with `?detail=true`)

12 entries, January first: `{ "month": "Jan", "bill_self_use": …, "bill_optimised": … }`. The
months add up to the year-1 bills to within a few pence of rounding.

### Example response

The request from §2, with `?detail=true` (the `years` array shortened here):

```json
{
  "year1": {
    "bill_self_use": 44.57,
    "bill_optimised": -280.35,
    "saving_total": 1190.35,
    "saving_tariff_and_solar": 865.43,
    "saving_optimisation": 324.92,
    "optimisation_uplift": 0.375,
    "monthly_saving": 99.2,
    "simple_payback_years": 10.08
  },
  "energy": {
    "grid_import_outside_cheap_kwh": 1307,
    "grid_charge_kwh": 1582,
    "battery_export_kwh": 3008,
    "curtailed_kwh": 0
  },
  "lifetime": {
    "payback_years": 8.5,
    "saving_25yr": 52867.79,
    "roi": 4.406,
    "net_roi": 3.406,
    "years": [
      { "year": 1, "saving": 1190.35, "cumulative_saving": 1190.35, "net_position": -10809.65 },
      { "year": 2, "saving": 1243.62, "cumulative_saving": 2433.97, "net_position": -9566.03 },
      { "year": 25, "saving": 3403.86, "cumulative_saving": 52867.79, "net_position": 40867.79 }
    ]
  },
  "meta": {
    "tariff": "flux",
    "usage": "half_day",
    "config_version": "2026-10.1",
    "assumptions": {
      "bands": [
        { "start": "02:00", "end": "05:00", "import": 0.16, "export": 0.0467, "cheap": true },
        { "start": "05:00", "end": "16:00", "import": 0.265, "export": 0.11, "cheap": false },
        { "start": "16:00", "end": "19:00", "import": 0.37, "export": 0.3, "cheap": false },
        { "start": "19:00", "end": "02:00", "import": 0.265, "export": 0.11, "cheap": false }
      ],
      "battery_usable_fraction": 0.9,
      "battery_round_trip_efficiency": 0.9,
      "degradation": 0.005,
      "inflation": 0.05,
      "self_use_fraction_applied": 0.35,
      "standing_charges": "excluded"
    }
  },
  "comparison": {
    "solar_savings_diff": 490.35,
    "payback_diff": -3,
    "saving_25yr_diff": 26867.79,
    "roi_diff": 2.236
  },
  "monthly": [
    { "month": "Jan", "bill_self_use": 61.47, "bill_optimised": 32.05 },
    { "month": "Feb", "bill_self_use": 34.16, "bill_optimised": 14.47 },
    { "month": "Mar", "bill_self_use": 4.9, "bill_optimised": -10.9 },
    { "month": "Apr", "bill_self_use": -18.87, "bill_optimised": -45.17 },
    { "month": "May", "bill_self_use": -35.14, "bill_optimised": -69.99 },
    { "month": "Jun", "bill_self_use": -40.88, "bill_optimised": -76.54 },
    { "month": "Jul", "bill_self_use": -41.15, "bill_optimised": -77.88 },
    { "month": "Aug", "bill_self_use": -30.19, "bill_optimised": -61.89 },
    { "month": "Sep", "bill_self_use": -11.69, "bill_optimised": -33.39 },
    { "month": "Oct", "bill_self_use": 15.25, "bill_optimised": -3.91 },
    { "month": "Nov", "bill_self_use": 45.05, "bill_optimised": 22.11 },
    { "month": "Dec", "bill_self_use": 61.66, "bill_optimised": 30.68 }
  ]
}
```

### More examples (real outputs, `year1` only)

**Solar, no battery, flat tariff** — `{"annual_usage":3500,"annual_gen":4000,"battery_kwh":0,"inverter_kw":0,"system_cost":7000,"tariff":"flat"}`
Bills are equal, so there is nothing to optimise. Checkable by hand: 35% of 4,000 kWh used
directly = 1,400 kWh; import 2,100 × £0.26 = £546; export 2,600 × £0.12 = £312; bill £234.

```json
{ "bill_self_use": 234, "bill_optimised": 234, "saving_total": 676, "saving_tariff_and_solar": 676,
  "saving_optimisation": 0, "optimisation_uplift": 0, "monthly_saving": 56.33, "simple_payback_years": 10.36 }
```

**Battery only, Go** — `{"annual_usage":4500,"annual_gen":0,"battery_kwh":10,"inverter_kw":5,"system_cost":5000,"tariff":"go","usage":"out_all_day"}`
Go's 29.19p day rate is above the 26p standard rate, so switching without optimising costs
money (`saving_tariff_and_solar` negative, `optimisation_uplift` null); charging overnight at
8.81p turns that into a £557 saving.

```json
{ "bill_self_use": 1217.01, "bill_optimised": 612.39, "saving_total": 557.61, "saving_tariff_and_solar": -47.01,
  "saving_optimisation": 604.62, "optimisation_uplift": null, "monthly_saving": 46.47, "simple_payback_years": 8.97 }
```

**Negative bill** — `{"annual_usage":2000,"annual_gen":7000,"battery_kwh":13.5,"inverter_kw":5,"system_cost":15000,"tariff":"flux","export_limit_kw":3.68}`
Export income exceeds import cost; negative bills are valid results, not errors.

```json
{ "bill_self_use": -704.87, "bill_optimised": -1192.9, "saving_total": 1712.9, "saving_tariff_and_solar": 1224.87,
  "saving_optimisation": 488.03, "optimisation_uplift": 0.398, "monthly_saving": 142.74, "simple_payback_years": 8.76 }
```

---

## 4. Errors

Every error has the same shape, and its `request_id` matches the `X-Request-Id` header:

```json
{ "error": { "code": "...", "message": "...", "request_id": "...", "fields": [ ... ] } }
```

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_request` | The body isn't a JSON object, or any field fails validation. `fields` lists **every** failing field at once. |
| `401` | `unauthorized` | No `Authorization` header, not `Bearer <key>`, or the key is unknown/revoked. |
| `429` | `rate_limited` | Over the per-key limit. Wait `Retry-After` seconds. |
| `500` | `internal_error` | Unexpected failure. Quote the `request_id` when reporting it. |

What triggers a `400`:

- a required field missing (`"issue": "is required"`) or negative;
- `annual_usage` = 0;
- `system_cost` = 0 (needed to divide by for payback and ROI — *a rule added beyond the brief*);
- `tariff` or `usage` not one of the listed values;
- `self_use_fraction` outside 0–1; `inflation` outside −10 to 20;
- `std_import`, `dn_day`, `dn_night`, `export_limit_kw` or `report_payback` negative;
- any number sent as a string, or a value above the sanity caps in §2.

Not errors: `battery_kwh` = 0 or `inverter_kw` = 0 (no battery), `annual_gen` = 0 (no
solar), and negative bills.

```json
{
  "error": {
    "code": "invalid_request",
    "message": "One or more fields are invalid.",
    "request_id": "5f705861-adfa-4c37-b79e-cfa5bf0cd119",
    "fields": [
      { "field": "annual_usage", "issue": "must be greater than 0" },
      { "field": "tariff", "issue": "must be one of flux, go, economy7, flat" },
      { "field": "inflation", "issue": "must be between -10 and 20" }
    ]
  }
}
```

---

## 5. How the calculation works

1. **Twelve representative days.** Each month is one typical day of 48 half-hours, counted
   for the number of days in that month. Consumption per month follows the UK domestic
   seasonal pattern (more in winter); solar per month follows a south-facing UK pattern (more
   in summer). Within the day, consumption follows the chosen `usage` profile and solar
   follows a curve from sunrise to sunset for that month.
2. **Direct self-use is pinned to the OpenSolar figure.** The household's timing is adjusted —
   never its daily total — until the solar used directly over the year equals
   `self_use_fraction × annual_gen`. So `self_use_fraction` decides *how much* solar the home
   uses before any battery, and `usage` decides *when* the rest of its demand falls.
3. **Every half-hour**, in this order: solar meets the home; spare solar charges the battery;
   in the cheap window the optimiser may top the battery up from the grid; the battery covers
   what the home still needs; spare solar is exported up to the export limit (the rest is
   curtailed); on Flux the battery may also export in the 16:00–19:00 peak; anything still
   needed is imported. Battery charging and discharging share the inverter's rating
   (`inverter_kw × 0.5` kWh per half-hour).
4. **Self-use** runs one fixed rule: no grid charging, no battery export.
   **Optimised** tries a set of strategies for each month's day — grid-charge targets of 0,
   25, 50, 75 and 100% of the battery, plus "fill only the room today's solar won't"; holding
   the battery during the cheap window; on Flux, exporting at the peak while keeping enough for
   the evening, or exporting everything — and keeps the cheapest. Self-use is always one of
   the strategies, which is why the optimised bill can never be higher.
5. **Steady state.** Each day is repeated until the battery starts and ends at the same
   charge, so a result never depends on an arbitrary starting charge.
6. **Bills** are import cost minus export income over the year. **Savings and the 25-year
   table** follow the formulas in §3.

### Assumptions in config version `2026-10.1`

Octopus Energy rates, taken on 2026-10-20 from Octopus's public tariff API, averaged across the
14 GB regions, paying by direct debit, including VAT. Times are UK clock time.

| Tariff | Import | Export | Cheap (grid-charging) window |
|---|---|---|---|
| `flux` | 16.0p 02:00–05:00 · 37.0p 16:00–19:00 · 26.5p otherwise | 4.67p · 30.0p · 11.0p in the same bands | 02:00–05:00 |
| `go` (Intelligent Octopus Go) | 8.81p 00:30–05:30 · 29.19p otherwise | 12.0p (Outgoing Octopus) | 00:30–05:30 |
| `economy7` | `dn_night` 00:30–07:30 · `dn_day` otherwise | 12.0p (Outgoing Octopus) | 00:30–07:30 |
| `flat` | `std_import` all day | 12.0p (Outgoing Octopus) | none |

| Constant | Value |
|---|---|
| Usable battery capacity | 90% of `battery_kwh` |
| Round-trip efficiency | 90% |
| Degradation of savings | 0.5% per year |
| Standing charges | Not included (they are much the same with or without a system) |

### Limits of the model — read before quoting figures

- **Typical days, not weather.** Each month is an average day. Real sunny and dull days vary
  more, so the model **understates export-limit curtailment**: average days rarely reach
  the cap.
- **Perfect foresight within a day.** The optimiser knows that day's solar and demand. Real
  systems forecast, so treat `saving_optimisation` as the achievable upper end.
- **Battery export on Flux only.** On tariffs with one export rate the battery doesn't
  export; any spare solar is exported directly.
- **One region's day.** Rates are GB averages; the Economy 7 night window varies by meter.
- **Rates move.** Octopus rates change roughly quarterly. Responses state which
  `config_version` they used; a new version is published when the rates are refreshed.
