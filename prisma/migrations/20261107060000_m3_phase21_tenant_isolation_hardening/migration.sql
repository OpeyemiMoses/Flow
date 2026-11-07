BEGIN;

-- Harden Row Level Security on flow.wallet_balances
-- Remove caller-controlled user id GUCs. Authorization requires verified session token.
DO $$
DECLARE
  db_name text := current_database();
  app_role text := db_name || '_app';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE 'DROP POLICY IF EXISTS balance_app_tenant_policy ON flow.wallet_balances';

    EXECUTE format(
      $policy$
      CREATE POLICY balance_app_tenant_policy ON flow.wallet_balances
      FOR SELECT TO %I
      USING (
        EXISTS (
          SELECT 1 FROM flow.auth_sessions s
          JOIN flow.users u ON u.auth_user_id = s.user_id
          JOIN flow.wallets w ON w.id = flow.wallet_balances.wallet_id
          JOIN flow.accounts a ON a.id = w.account_id
          LEFT JOIN flow.account_memberships m ON m.account_id = a.id
            AND m.status = 'ACTIVE'::flow.member_status
            AND m.user_id = u.id
          WHERE s.token = NULLIF(current_setting('flow.current_session_token', true), '')
            AND s.expires_at > CURRENT_TIMESTAMP
            AND u.active = true
            AND a.id = NULLIF(current_setting('flow.current_account_id', true), '')::uuid
            AND (
              (a.kind = 'PERSONAL' AND a.personal_owner_id = u.id)
              OR
              (a.kind = 'BUSINESS' AND m.id IS NOT NULL)
            )
        )
      )
      $policy$,
      app_role
    );
  END IF;
END;
$$;

COMMIT;
