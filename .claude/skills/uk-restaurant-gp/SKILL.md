---
name: uk-restaurant-gp
description: Use for UK restaurant gross profit (GP) costing - dish costing, VAT handling, target pricing, delivery commission pricing and GP benchmarks.
---

# UK restaurant GP costing

Source for the method and benchmarks: Jelly Blog, "GP Margin Calculator for UK Restaurants" (blog.getjelly.co.uk/gp-margin-calculator-food-beverage). Benchmarks are indicative, not rules.

## Formulas (VAT = 0.20, waste as a fraction)
- unit cost = pack price ex-VAT / pack size in base units
- line cost = quantity x unit cost x (1 + waste)
- true cost = sum of line costs / portions
- price ex-VAT = menu price inc-VAT / (1 + VAT)
- GP money = price ex-VAT - true cost; GP % = GP money / price ex-VAT
- suggested price ex-VAT = true cost / (1 - target GP); inc-VAT = x (1 + VAT)
- delivery price ex-VAT = (price ex-VAT + packaging) / (1 - commission)
- delivery GP % = (revenue kept - packaging - true cost) / revenue kept, where revenue kept = delivery price ex-VAT x (1 - commission)
- markup % = (price - cost) / cost  (NOT the same as GP %; 70% GP = 233% markup)

## Rules of thumb
- ALWAYS calculate GP on ex-VAT figures; using VAT-inclusive prices overstates GP by about 17 points
- Many UK food ingredients are zero-rated; do not blindly divide supplier prices by 1.20. Store VAT per ingredient. Confirm specifics with the owner's accountant
- Typical targets: food 65-70%, drinks 65-75%; below about 60% is a warning sign; delivery after 25-35% commission lands around 35-40% effective GP
- Waste buffer: about 5-8% for fresh food, 1-3% for sealed drinks
- Round suggested prices UP only, so GP never falls below target
- Round only for display; calculate at full precision

## Test vector
Ingredient cost 4.50, waste 6% -> true cost 4.77. Menu 18.00 inc-VAT -> 15.00 ex-VAT, GP 10.23, GP% 68.2%. Target 70% -> 15.90 ex-VAT, 19.08 inc-VAT.
