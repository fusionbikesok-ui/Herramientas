-- Permisos de plataforma_app (diseño tramo 1 §3). La auditoría sólo admite SELECT e INSERT.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA core, security, audit, integrations TO plataforma_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA core, security, integrations TO plataforma_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO plataforma_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA core, security, audit, integrations TO plataforma_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA audit TO plataforma_app;
REVOKE ALL ON core.schema_migrations FROM plataforma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE plataforma_migrador IN SCHEMA core, security, integrations GRANT SELECT, INSERT, UPDATE ON TABLES TO plataforma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE plataforma_migrador IN SCHEMA audit GRANT SELECT, INSERT ON TABLES TO plataforma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE plataforma_migrador IN SCHEMA core, security, audit, integrations GRANT USAGE ON SEQUENCES TO plataforma_app;
ALTER DEFAULT PRIVILEGES FOR ROLE plataforma_migrador IN SCHEMA audit GRANT EXECUTE ON FUNCTIONS TO plataforma_app;
