\set ON_ERROR_STOP on

-- FLOW Staging Database Bootstrap Script for Neon PostgreSQL 17
-- Run as the project administrator (e.g. neondb_owner) via psql or Neon SQL Editor.
-- Replace placeholder passwords with strong, randomly generated passwords (>= 16 characters).

CREATE ROLE flow_staging_migrator LOGIN PASSWORD 'replace-with-staging-migrator-password';
CREATE ROLE flow_staging_app LOGIN PASSWORD 'replace-with-staging-app-password';

CREATE DATABASE flow_staging OWNER flow_staging_migrator;

REVOKE ALL ON DATABASE flow_staging FROM PUBLIC;
GRANT CONNECT ON DATABASE flow_staging TO flow_staging_app;

