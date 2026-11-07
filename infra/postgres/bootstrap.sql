\set ON_ERROR_STOP on
\getenv local_app_password FLOW_LOCAL_APP_PASSWORD
\getenv local_worker_password FLOW_LOCAL_WORKER_PASSWORD
\getenv local_operator_password FLOW_LOCAL_OPERATOR_PASSWORD
\getenv local_migrator_password FLOW_LOCAL_MIGRATOR_PASSWORD
\getenv test_app_password FLOW_TEST_APP_PASSWORD
\getenv test_worker_password FLOW_TEST_WORKER_PASSWORD
\getenv test_operator_password FLOW_TEST_OPERATOR_PASSWORD
\getenv test_migrator_password FLOW_TEST_MIGRATOR_PASSWORD

CREATE ROLE flow_local_app LOGIN PASSWORD :'local_app_password';
CREATE ROLE flow_local_worker LOGIN PASSWORD :'local_worker_password';
CREATE ROLE flow_local_operator LOGIN PASSWORD :'local_operator_password';
CREATE ROLE flow_local_migrator LOGIN PASSWORD :'local_migrator_password';
CREATE ROLE flow_test_app LOGIN PASSWORD :'test_app_password';
CREATE ROLE flow_test_worker LOGIN PASSWORD :'test_worker_password';
CREATE ROLE flow_test_operator LOGIN PASSWORD :'test_operator_password';
CREATE ROLE flow_test_migrator LOGIN PASSWORD :'test_migrator_password';

CREATE DATABASE flow_local OWNER flow_local_migrator;
CREATE DATABASE flow_test OWNER flow_test_migrator;

REVOKE ALL ON DATABASE flow_local FROM PUBLIC;
REVOKE ALL ON DATABASE flow_test FROM PUBLIC;
GRANT CONNECT ON DATABASE flow_local TO flow_local_app;
GRANT CONNECT ON DATABASE flow_local TO flow_local_worker;
GRANT CONNECT ON DATABASE flow_local TO flow_local_operator;
GRANT CONNECT ON DATABASE flow_test TO flow_test_app;
GRANT CONNECT ON DATABASE flow_test TO flow_test_worker;
GRANT CONNECT ON DATABASE flow_test TO flow_test_operator;
