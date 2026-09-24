"""Create/rotate the least-privilege application role without logging secrets."""
from __future__ import annotations

import os
from urllib.parse import quote

import psycopg
from psycopg import sql


def main() -> None:
    host = os.environ["POSTGRES_HOST"]
    database = os.environ.get("POSTGRES_DATABASE", "norium")
    admin = os.environ["POSTGRES_ADMIN_LOGIN"]
    admin_password = os.environ["POSTGRES_ADMIN_PASSWORD"]
    app_login = os.environ.get("POSTGRES_APP_LOGIN", "norium_app")
    app_password = os.environ["POSTGRES_APP_PASSWORD"]
    ca_bundle = os.environ["NORIUM_DATABASE_SSLROOTCERT"]
    with psycopg.connect(host=host, dbname=database, user=admin, password=admin_password,
                         sslmode="verify-full", sslrootcert=ca_bundle, connect_timeout=15, autocommit=True) as db:
        exists = db.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (app_login,)).fetchone()
        if exists:
            db.execute(sql.SQL("ALTER ROLE {} LOGIN PASSWORD {}").format(sql.Identifier(app_login), sql.Literal(app_password)))
        else:
            db.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD {}").format(sql.Identifier(app_login), sql.Literal(app_password)))
        db.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(database), sql.Identifier(app_login)))
        db.execute(sql.SQL("GRANT USAGE, CREATE ON SCHEMA public TO {}").format(sql.Identifier(app_login)))
    encoded_login, encoded_password = quote(app_login, safe=""), quote(app_password, safe="")
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as target:
        target.write(f"NORIUM_DATABASE_URL=postgresql://{encoded_login}:{encoded_password}@{host}:5432/{database}\n")
    print("postgres_application_role_ready")


if __name__ == "__main__":
    main()

