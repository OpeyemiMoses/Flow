BEGIN;

-- CreateTable: flow.provider_compatibility_authorizations
CREATE TABLE flow.provider_compatibility_authorizations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  environment text NOT NULL,
  allowed_methods text[] NOT NULL,
  status text NOT NULL DEFAULT 'AUTHORIZED',
  max_registrations integer NOT NULL DEFAULT 1,
  registrations_attempted integer NOT NULL DEFAULT 0,
  registrations_completed integer NOT NULL DEFAULT 0,
  claimed_at timestamp(3),
  claimed_by text,
  consumed_at timestamp(3),
  expires_at timestamp(3) NOT NULL,
  dispatch_attempt_id uuid,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT provider_compatibility_authorizations_pkey PRIMARY KEY (id),
  CONSTRAINT provider_compatibility_authorizations_account_id_fkey FOREIGN KEY (account_id) REFERENCES flow.accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT provider_compatibility_authorizations_max_reg_check CHECK (max_registrations = 1),
  CONSTRAINT provider_compatibility_authorizations_attempt_check CHECK (registrations_attempted <= 1)
);

CREATE INDEX provider_compatibility_authorizations_account_id_status_idx ON flow.provider_compatibility_authorizations(account_id, status);

-- CreateTable: flow.custody_operators
CREATE TABLE flow.custody_operators (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  auth_user_id text NOT NULL,
  role text NOT NULL DEFAULT 'CUSTODY_OPERATOR',
  status text NOT NULL DEFAULT 'ACTIVE',
  enrolled_by text NOT NULL,
  enrolled_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT custody_operators_pkey PRIMARY KEY (id),
  CONSTRAINT custody_operators_auth_user_id_key UNIQUE (auth_user_id),
  CONSTRAINT custody_operators_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES flow.auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable: flow.custody_recovery_approvals
CREATE TABLE flow.custody_recovery_approvals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  account_id uuid NOT NULL,
  approver_auth_id text NOT NULL,
  resolution text NOT NULL,
  approval_token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  expires_at timestamp(3) NOT NULL,
  consumed_at timestamp(3),
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT custody_recovery_approvals_pkey PRIMARY KEY (id),
  CONSTRAINT custody_recovery_approvals_approval_token_hash_key UNIQUE (approval_token_hash),
  CONSTRAINT custody_recovery_approvals_job_id_fkey FOREIGN KEY (job_id) REFERENCES flow.wallet_provisioning_jobs(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT custody_recovery_approvals_account_id_fkey FOREIGN KEY (account_id) REFERENCES flow.accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT custody_recovery_approvals_approver_auth_id_fkey FOREIGN KEY (approver_auth_id) REFERENCES flow.auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX custody_recovery_approvals_job_id_status_idx ON flow.custody_recovery_approvals(job_id, status);

-- Grants: app role receives SELECT, INSERT, UPDATE on the new tables (NO DELETE)
DO $$
DECLARE app_role text := current_database() || '_app';
BEGIN
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON flow.provider_compatibility_authorizations, flow.custody_operators, flow.custody_recovery_approvals TO %I', app_role);
END;
$$;

COMMIT;
