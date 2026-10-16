from __future__ import annotations

import logging
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SOURCE_COLUMNS = (
    "id_woo", "nombre", "sku", "tipo", "id_padre", "stock", "actualizado_en",
    "categorias_json", "img", "precio", "atributos_json", "marca", "gtin",
    "regular_price", "no_contable",
)

logger = logging.getLogger("fusion-chatbot.catalog-exporter")


def _connect_source(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30.0)
    connection.execute("PRAGMA query_only=ON")
    return connection


def _validate_source(connection: sqlite3.Connection) -> None:
    columns = {
        str(row[1]) for row in connection.execute("PRAGMA table_info(catalogo_cache)")
    }
    missing = set(SOURCE_COLUMNS) - columns
    if missing:
        raise RuntimeError("catalogo_cache_missing_columns:" + ",".join(sorted(missing)))


def export_catalog_once(source_path: str | Path, output_path: str | Path) -> dict[str, Any]:
    source = Path(source_path)
    output = Path(output_path)
    if not source.is_file():
        raise FileNotFoundError(f"source_catalog_not_found:{source}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp-{os.getpid()}")
    if temporary.exists():
        temporary.unlink()

    source_connection = _connect_source(source)
    try:
        _validate_source(source_connection)
        source_connection.execute("BEGIN")
        column_list = ",".join(SOURCE_COLUMNS)
        rows = source_connection.execute(
            f"SELECT {column_list} FROM catalogo_cache"
        ).fetchall()
        source_updated_at = source_connection.execute(
            "SELECT COALESCE(MAX(actualizado_en), '') FROM catalogo_cache"
        ).fetchone()[0]
        source_connection.rollback()
    finally:
        source_connection.close()
    if not rows:
        raise RuntimeError("catalogo_cache_empty")

    destination = sqlite3.connect(str(temporary), timeout=30.0)
    try:
        destination.executescript("""
            PRAGMA journal_mode=OFF;
            PRAGMA synchronous=OFF;
            CREATE TABLE catalog_products (
                id_woo INTEGER PRIMARY KEY,
                nombre TEXT NOT NULL,
                sku TEXT,
                tipo TEXT NOT NULL,
                id_padre INTEGER,
                stock INTEGER NOT NULL DEFAULT 0,
                actualizado_en TEXT,
                categorias_json TEXT,
                img TEXT,
                precio REAL,
                atributos_json TEXT,
                marca TEXT,
                gtin TEXT,
                regular_price REAL,
                no_contable INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        """)
        placeholders = ",".join("?" for _ in SOURCE_COLUMNS)
        destination.executemany(
            f"INSERT INTO catalog_products ({','.join(SOURCE_COLUMNS)}) VALUES ({placeholders})",
            rows,
        )
        exported_at = datetime.now(timezone.utc).isoformat()
        metadata = {
            "exported_at": exported_at,
            "source_catalog_updated_at": str(source_updated_at or ""),
            "source_db_mtime": str(source.stat().st_mtime),
            "source_rows": str(len(rows)),
            "schema_version": "1",
        }
        destination.executemany(
            "INSERT INTO metadata(key, value) VALUES (?, ?)",
            metadata.items(),
        )
        destination.executescript("""
            CREATE INDEX catalog_products_parent_idx ON catalog_products(id_padre);
            CREATE INDEX catalog_products_type_idx ON catalog_products(tipo);
            CREATE INDEX catalog_products_stock_idx ON catalog_products(stock);
            CREATE INDEX catalog_products_brand_idx ON catalog_products(marca);
            CREATE INDEX catalog_products_updated_idx ON catalog_products(actualizado_en);
            PRAGMA user_version=1;
            ANALYZE;
        """)
        destination.commit()
    finally:
        destination.close()

    os.chmod(temporary, 0o644)
    descriptor = os.open(temporary, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, output)
    try:
        directory_descriptor = os.open(output.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except OSError:
        pass
    return {
        "rows": len(rows),
        "exported_at": exported_at,
        "source_catalog_updated_at": str(source_updated_at or ""),
        "output": str(output),
    }


def main() -> None:
    logging.basicConfig(
        level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    source = os.getenv("CATALOG_SOURCE_DB", "/source/fusion.sqlite")
    output = os.getenv("CATALOG_SQLITE_PATH", "/catalog/catalog.sqlite")
    try:
        interval = max(60, min(int(os.getenv("CATALOG_EXPORT_INTERVAL_SECONDS", "180")), 3600))
    except ValueError:
        interval = 180
    while True:
        try:
            result = export_catalog_once(source, output)
            logger.info(
                "catalog_export_ok rows=%s source_updated_at=%s",
                result["rows"],
                result["source_catalog_updated_at"],
            )
            delay = interval
        except Exception:
            logger.exception("catalog_export_failed")
            delay = min(interval, 30)
        time.sleep(delay)


if __name__ == "__main__":
    main()
