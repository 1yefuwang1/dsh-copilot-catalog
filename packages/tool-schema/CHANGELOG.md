# Changelog

## 0.1.2 — DSH 0.2.1-rc.3 compatibility

- Retarget the exact runtime pins to DSH/`@deepseek-ai/dsh-system-prompt`
  `0.2.1-rc.3`, Cordis `~4.0.5` and Schemastery `~3.18.5`.
- No behavior change: the outer `system-prompt/assemble` waterfall contract and
  its registration order, disposal and failure containment are unchanged.

## 0.1.1 — DSH 0.2.1-rc.2 compatibility

- Retarget the exact runtime pins to DSH/`@deepseek-ai/dsh-system-prompt`
  `0.2.1-rc.2`, Cordis `~4.0.5` and Schemastery `~3.18.5`.
- No behavior change: the outer `system-prompt/assemble` waterfall contract and its
  registration order, disposal and failure containment are unchanged.

## 0.1.0 — Copilot Gemini properties-bucket guard

- Add an outer `system-prompt/assemble` listener that adds a missing root
  `properties` bucket to object tool parameter schemas for configured Copilot
  Gemini routes; measured to turn a plain-text HTTP 400 into 200 for the reported
  `workspace_project` declaration.
- Keep the change surgical: conformant declarations are byte-identical, references
  and non-object schemas are skipped with a controlled code, and no keywords,
  descriptions, unions or output schemas are rewritten.
- Cover registration order, disposal, idempotency, duplicate installation and
  failure containment with unit and real-service integration tests, including a real
  `createScope` + `installModelSelection` composition in both registration orders, an
  offline pi-ai wire capture with its negative control, and skip/fix logging.
