-- Bounded normal retention cleanup, not corruption repair. Foreign keys must be ON.
-- An inconsistent lifecycle is preserved for operator review, never reset to OPEN.
DELETE FROM form_intents
WHERE id IN (
  SELECT i.id FROM form_intents AS i
  LEFT JOIN action_results AS r ON r.intent_id=i.id
  LEFT JOIN order_drafts AS d ON d.intent_id=i.id
  WHERE (i.consumed_at IS NULL AND r.intent_id IS NULL AND d.id IS NULL AND i.expires_at <= :now)
     OR (i.consumed_at IS NOT NULL AND r.intent_id IS NOT NULL AND d.id=r.draft_id
         AND r.behavior_hash=i.behavior_hash AND r.completed_at=i.consumed_at
         AND d.tenant_id=i.tenant_id AND d.subject_id=i.subject_id AND d.product_id=i.product_id
         AND r.expires_at <= :now)
  ORDER BY i.issued_at LIMIT 100
);
