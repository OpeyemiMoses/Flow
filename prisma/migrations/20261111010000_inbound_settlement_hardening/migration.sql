-- Migration: 20261111010000_inbound_settlement_hardening
-- Settlement hardening: support RECONCILIATION_REQUIRED in flow.payment_attempts
BEGIN;

-- 1. Update check constraint on flow.payment_attempts to support RECONCILIATION_REQUIRED
ALTER TABLE flow.payment_attempts DROP CONSTRAINT IF EXISTS chk_payment_attempts_status;
ALTER TABLE flow.payment_attempts
    ADD CONSTRAINT chk_payment_attempts_status CHECK (
        status IN (
            'QUOTE_OBSERVED',
            'QUOTE_EXPIRED',
            'QUOTE_CANCELLED',
            'DEPOSIT_COMMITTED',
            'SETTLING',
            'SETTLED',
            'FAILED',
            'EXPIRED',
            'EXCEPTION_REFUND_REQUIRED',
            'RECONCILIATION_REQUIRED'
        )
    );

COMMIT;
