-- Multi-batch send continuation: campaigns track the highest fully-committed
-- batch index so queue redeliveries derive a stable Resend idempotency key.
ALTER TABLE campaigns ADD COLUMN last_completed_batch INTEGER;

-- send_jobs was never written or read by application code; recipient rows plus
-- last_completed_batch fully encode send state.
DROP TABLE IF EXISTS send_jobs;
