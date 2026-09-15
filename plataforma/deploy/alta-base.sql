\set ON_ERROR_STOP on
SELECT format('CREATE ROLE plataforma_migrador LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'pw_migrador')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plataforma_migrador') \gexec
SELECT format('CREATE ROLE plataforma_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'pw_app')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plataforma_app') \gexec
SELECT format('ALTER ROLE plataforma_migrador PASSWORD %L', :'pw_migrador') \gexec
SELECT format('ALTER ROLE plataforma_app PASSWORD %L', :'pw_app') \gexec
SELECT 'CREATE DATABASE plataforma OWNER plataforma_migrador'
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'plataforma') \gexec
REVOKE ALL ON DATABASE plataforma FROM PUBLIC;
GRANT CONNECT ON DATABASE plataforma TO plataforma_app;
