-- Operator diagnostic. Do not expose these reasons in an unauthenticated response.
SELECT i.id AS intent_id,
 CASE
   WHEN i.consumed_at IS NULL AND (r.intent_id IS NOT NULL OR d.id IS NOT NULL) THEN 'OPEN_WITH_DURABLE_WORK'
   WHEN i.consumed_at IS NOT NULL AND (r.intent_id IS NULL OR d.id IS NULL) THEN 'CONSUMED_WITHOUT_RESULT'
   WHEN r.intent_id IS NOT NULL AND (r.draft_id IS NOT d.id OR r.behavior_hash IS NOT i.behavior_hash
      OR r.completed_at IS NOT i.consumed_at) THEN 'RESULT_METADATA_MISMATCH'
   WHEN d.id IS NOT NULL AND (d.tenant_id IS NOT i.tenant_id OR d.subject_id IS NOT i.subject_id
      OR d.product_id IS NOT i.product_id) THEN 'DRAFT_SCOPE_MISMATCH'
 END AS reason
FROM form_intents AS i
LEFT JOIN action_results AS r ON r.intent_id=i.id
LEFT JOIN order_drafts AS d ON d.intent_id=i.id
WHERE reason IS NOT NULL
ORDER BY i.issued_at LIMIT 100;
