# Changelog

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
