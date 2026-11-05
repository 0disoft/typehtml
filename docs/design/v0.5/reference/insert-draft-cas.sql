-- Inside one IMMEDIATE transaction after current policy/grant checks. Require changes()=1.
-- The adapter also checks grant identity, active transaction, integer arithmetic and scope.
INSERT INTO order_drafts
  (id,intent_id,tenant_id,subject_id,product_id,product_revision,quantity,total_minor,currency,state)
SELECT :draftId,i.id,p.tenant_id,:subjectId,p.id,p.revision,:quantity,p.price_minor * :quantity,p.currency,'draft'
FROM form_intents AS i
JOIN products AS p ON p.tenant_id=i.tenant_id AND p.id=i.product_id AND p.revision=i.resource_revision
JOIN memberships AS m ON m.tenant_id=p.tenant_id AND m.subject_id=i.subject_id AND m.active=1
WHERE i.id=:intentId AND i.tenant_id=:tenantId AND i.subject_id=:subjectId
  AND i.action_id='orders.createDraft' AND i.product_id=:productId
  AND i.behavior_hash=:behaviorHash AND i.consumed_at IS NULL AND i.expires_at>:now
  AND p.revision=:expectedRevision AND p.active=1;
