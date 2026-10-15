---
name: csv-import-preview-commit
description: Use when building a bulk CSV import feature - parse, validate, preview changes, then commit in one transaction.
---

# CSV import: parse, validate, preview, commit

## Flow
1. Upload (size and row limits, CSV only, memory storage)
2. Parse leniently: strip BOM, trim and lower-case headers, support header aliases, handle currency symbols, thousands separators, percent formats, yes/no booleans, mixed-case units
3. Validate every row; collect errors as `{row, field, message}` with plain-English messages that say how to fix it
4. Match against existing records on a documented natural key (e.g. lower(name) + lower(supplier))
5. Build a preview: counts of new / changed / unchanged / rejected; old vs new values and percentage change for changed rows; downloadable errors CSV
6. Store the parsed batch server-side (not in the browser) and commit from that stored batch only after explicit confirmation
7. Commit in ONE transaction; write history rows for changed values; summarise results; flag any knock-on effects

## Rules
- Nothing is written before confirmation
- Bad rows are skipped and reported; they never abort the good rows
- Re-uploading the same file must be a no-op (idempotent)
- Provide a downloadable template and an export in the same format so export, edit, re-import works
- Test with: BOM, wrong delimiter, blank lines, duplicate rows within the file, huge file, non-numeric prices, unknown units
