-- The monthly scan now resolves locally when there is no OpenAI consent.
-- Retry older in-flight attempts under the new policy, without revisiting completed work.
UPDATE gmail_deliveries d
SET attempt_id=NULL, attempts=0, due_at=now()
FROM gmail_reprocess_runs r
WHERE d.reprocess_id=r.id AND d.completed_at IS NULL AND r.finished_at IS NULL;
