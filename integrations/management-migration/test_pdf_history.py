"""Focused history tests: synthetic PDFs only, temporary local databases, no VPS."""
from datetime import datetime, timedelta, timezone
from contextlib import closing
import importlib.util
import os
import sqlite3
import shutil
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from pdf_history import HistoryError, HistoryStore


PDF = b"%PDF-1.7\nsynthetic-history-test\x00\xff\n%%EOF"
RULE = {
    "before": {"weight": "9000", "width": "20", "height": "30", "length": "40"},
    "after": {"weight": "15000", "width": "25", "height": "70", "length": "150"},
}


class HistoryTests(unittest.TestCase):
    def setUp(self):
        # Windows AppContainer cannot reopen directories created by Python's
        # restrictive mkdtemp DACL. Use an inherited-ACL synthetic workspace
        # directory; production HistoryStore permissions remain untouched.
        self.temp_root = Path(__file__).resolve().parent.parent / "test-tmp"
        self.directory = self.temp_root / ("pdf-history-" + uuid.uuid4().hex)
        self.directory.mkdir(parents=True)
        self.addCleanup(self.remove_test_directory)
        self.instant = datetime(2026, 10, 15, 15, 0, tzinfo=timezone.utc)
        self.store = HistoryStore(self.directory, now=lambda: self.instant, min_free_bytes=0)

    def remove_test_directory(self):
        target = self.directory.resolve()
        if target.parent != self.temp_root.resolve() or not target.name.startswith("pdf-history-"):
            raise RuntimeError("Unexpected test cleanup path")
        shutil.rmtree(target)

    def save(self, **overrides):
        data = {"source_name": "etiquetas.pdf", "user": "synthetic-admin",
                "rule": RULE, "total": 16, "pages": [3, 8]}
        data.update(overrides)
        return self.store.save(PDF, **data)

    def assert_status(self, status, function, *args, **kwargs):
        with self.assertRaises(HistoryError) as caught:
            function(*args, **kwargs)
        self.assertEqual(caught.exception.status, status)
        self.assertTrue(str(caught.exception))

    def test_new_instance_recovers_exact_bytes_and_all_metadata(self):
        meta = self.save(source_name="Envíos Córdoba.pdf")
        reopened = HistoryStore(self.directory, min_free_bytes=0)
        data, recovered = reopened.get(meta["id"])
        self.assertEqual(data, PDF)
        self.assertEqual(recovered, meta)
        self.assertEqual(recovered["source_name"], "Envíos Córdoba.pdf")
        self.assertEqual(recovered["name"], "Envíos Córdoba_corregido.pdf")
        self.assertEqual(recovered["username"], "synthetic-admin")
        self.assertEqual(recovered["size"], len(PDF))
        self.assertEqual(recovered["total"], 16)
        self.assertEqual(recovered["pages"], [3, 8])
        self.assertEqual(recovered["changed"], 2)
        self.assertEqual(recovered["rule"], RULE)
        listing = reopened.list()
        self.assertEqual(listing["items"], [meta])
        self.assertNotIn("pdf", listing["items"][0])
        self.assertNotIn("search_text", listing["items"][0])

    def test_identical_names_and_bytes_are_kept_as_separate_documents(self):
        first, second = self.save(), self.save()
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(uuid.UUID(first["id"]).version, 4)
        self.assertEqual(first["name"], second["name"])
        self.assertEqual(self.store.list()["total"], 2)
        for meta in (first, second):
            self.assertEqual(self.store.get(meta["id"])[0], PDF)

    def test_metadata_only_lookup_does_not_read_the_pdf_blob(self):
        meta = self.save()
        original_connect = self.store.connect
        columns_read = []

        def guarded_connect():
            db = original_connect()
            def authorize(action, table, column, database, trigger):
                if action == sqlite3.SQLITE_READ and table == "documents":
                    columns_read.append(column)
                    if column == "pdf":
                        return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK
            db.set_authorizer(authorize)
            return db

        with patch.object(self.store, "connect", side_effect=guarded_connect):
            body, recovered = self.store.get(meta["id"], include_pdf=False)
        self.assertEqual(body, b"")
        self.assertEqual(recovered, meta)
        self.assertTrue(columns_read)
        self.assertNotIn("pdf", columns_read)
        self.assertEqual(self.store.get(meta["id"])[0], PDF)

    def test_worker_shared_slot_blocks_get_and_correction_while_head_uses_only_metadata(self):
        meta = self.save()
        spec = importlib.util.spec_from_file_location("synthetic_pdf_history_worker", Path(__file__).with_name("pdf-worker.py"))
        worker = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"FUSION_MANAGEMENT_SIGNING_KEY": "synthetic-test-key-" * 4,
                                     "FUSION_PDF_HISTORY_DIR": str(self.directory)}):
            spec.loader.exec_module(worker)
        handler = worker.Handler.__new__(worker.Handler)
        handler.headers = {"Authorization": "Bearer " + worker.TOKEN,
                           "Content-Type": "application/pdf", "Content-Length": "5"}
        replies = []
        handler.respond = lambda status, body, content_type="application/json", headers=None, length=None: replies.append(
            {"status": status, "body": body, "length": length, "headers": headers})
        self.assertTrue(worker.SLOT.acquire(blocking=False))
        try:
            handler.path = "/files/" + meta["id"]
            handler.command = "GET"
            handler.do_GET()
            self.assertEqual(replies[-1]["status"], 429)
            handler.command = "HEAD"
            with patch.object(worker.HISTORY, "get", wraps=worker.HISTORY.get) as get:
                handler.do_HEAD()
                get.assert_called_once_with(meta["id"], include_pdf=False)
            self.assertEqual(replies[-1]["status"], 200)
            self.assertEqual(replies[-1]["body"], b"")
            self.assertEqual(replies[-1]["length"], len(PDF))
            handler.command = "POST"
            handler.path = "/correct"
            handler.do_POST()
            self.assertEqual(replies[-1]["status"], 429)
        finally:
            worker.SLOT.release()
        handler.command = "GET"
        handler.path = "/files/" + meta["id"]
        handler.do_GET()
        self.assertEqual(replies[-1]["status"], 200)
        self.assertEqual(replies[-1]["body"], PDF)
        handler.path = "/files/" + str(uuid.uuid4())
        handler.do_GET()
        self.assertEqual(replies[-1]["status"], 404)
        self.assertTrue(worker.SLOT.acquire(blocking=False), "An unsuccessful lookup must release its slot")
        worker.SLOT.release()

    def test_grouping_uses_argentina_day_including_utc_midnight_boundary(self):
        for instant, expected in [
            (datetime(2026, 10, 15, 0, 0, tzinfo=timezone.utc), "2026-10-14"),
            (datetime(2026, 10, 15, 2, 59, 59, tzinfo=timezone.utc), "2026-10-14"),
            (datetime(2026, 10, 15, 3, 0, tzinfo=timezone.utc), "2026-10-15"),
            (datetime(2026, 10, 15, 5, 0, tzinfo=timezone(timedelta(hours=2))), "2026-10-15"),
        ]:
            with self.subTest(instant=instant):
                self.instant = instant
                meta = self.save()
                self.assertEqual(meta["day"], expected)
                stored = datetime.fromisoformat(meta["created_at"])
                self.assertEqual(stored.utcoffset(), timedelta(0))
                self.assertEqual(stored, instant)

    def test_naive_clock_is_rejected_without_saving(self):
        self.instant = datetime(2026, 10, 15, 10)
        self.assert_status(503, self.save)
        self.assertEqual(self.store.list()["total"], 0)

    def test_date_filters_are_inclusive_and_combine_with_search(self):
        records = []
        for day in (13, 14, 15, 16):
            self.instant = datetime(2026, 10, day, 15, tzinfo=timezone.utc)
            records.append(self.save(source_name=f"Envíos {day}.pdf"))
        result = self.store.list(date_from="2026-10-14", date_to="2026-10-15")
        self.assertEqual([item["id"] for item in result["items"]], [records[2]["id"], records[1]["id"]])
        self.assertEqual(result["total"], 2)
        self.assertEqual(self.store.list(date_from="2026-10-15")["total"], 2)
        self.assertEqual(self.store.list(date_to="2026-10-14")["total"], 2)
        one_day = self.store.list(q="envios", date_from="2026-10-15", date_to="2026-10-15")
        self.assertEqual([row["id"] for row in one_day["items"]], [records[2]["id"]])
        self.assertEqual(self.store.list(q="13", date_from="2026-10-14")["total"], 0)

    def test_search_is_case_and_accent_insensitive_but_percent_and_underscore_are_literal(self):
        special = self.save(source_name="Árbol_100%_Córdoba.pdf")
        plain = self.save(source_name="ArbolX100Y_sin_porcentaje.pdf")
        for query in ("ÁRBOL_100%_CÓRDOBA", "arbol_100%_cordoba", "co\u0301rdoba", "%", "_100%", "  CÓRDOBA  "):
            with self.subTest(query=query):
                self.assertEqual([item["id"] for item in self.store.list(q=query)["items"]], [special["id"]])
        self.assertEqual(self.store.list(q="ÁRBOL")["total"], 2)
        self.assertEqual(self.store.list(q="arbol_100Y")["total"], 0)
        self.assertEqual(self.store.list(q="%' OR 1=1 --")["total"], 0)
        self.assertEqual(self.store.get(plain["id"])[0], PDF)

    def test_pagination_is_twenty_items_and_stable_newest_first(self):
        ids = []
        for number in range(45):
            self.instant += timedelta(seconds=1)
            ids.append(self.save(source_name=f"lote-{number}.pdf")["id"])
        pages = [self.store.list(page=number) for number in (1, 2, 3)]
        self.assertEqual([len(page["items"]) for page in pages], [20, 20, 5])
        for number, page in enumerate(pages, 1):
            self.assertEqual((page["total"], page["page"], page["pages"], page["page_size"]), (45, number, 3, 20))
        self.assertEqual([item["id"] for page in pages for item in page["items"]], list(reversed(ids)))
        self.assertEqual(self.store.list(page="2"), pages[1])
        self.assertEqual(self.store.list(page=4)["items"], [])

    def test_empty_history_has_consistent_pagination(self):
        self.assertEqual(self.store.list(), {"items": [], "total": 0, "page": 1, "pages": 1, "page_size": 20})

    def test_invalid_and_missing_identifiers_are_not_found(self):
        valid = self.save()
        for identifier in (None, 1, "", "../history.sqlite3", "' OR 1=1 --", str(uuid.uuid1()),
                           valid["id"] + ".pdf", valid["id"] + "\n", str(uuid.uuid4())):
            with self.subTest(identifier=identifier):
                self.assert_status(404, self.store.get, identifier)
        self.assertEqual(self.store.get(valid["id"])[0], PDF)

    def test_source_names_cannot_add_paths_controls_or_bidirectional_marks(self):
        names = ["../../outside.pdf", "C:\\fake\\path\\etiquetas.pdf", "bad\r\nname\x00\x1f\x7f.pdf",
                 'a<>:"/\\|?*.pdf', "safe\u202efile.pdf", " . ", "A" * 300, "ETIQUETAS.PDF", "sin-extension"]
        for name in names:
            with self.subTest(name=name):
                meta = self.save(source_name=name)
                for key in ("source_name", "name"):
                    cleaned = meta[key]
                    self.assertTrue(cleaned.lower().endswith(".pdf"))
                    self.assertNotRegex(cleaned, r'[<>:"/\\|?*\x00-\x1f\x7f\u202e]')
                    self.assertEqual(Path(cleaned).name, cleaned)
                    self.assertFalse(cleaned.startswith((" ", ".")))
                self.assertLessEqual(len(meta["source_name"]), 164)
                self.assertEqual(self.store.get(meta["id"])[0], PDF)
        self.assertEqual(sorted(path.name for path in self.directory.iterdir()), ["history.sqlite3"])
        self.assertFalse((self.temp_root / "outside.pdf").exists())

    def test_low_disk_space_never_claims_success_and_existing_pdf_remains_readable(self):
        existing = self.save()
        self.store.min_free_bytes = 1000
        threshold = 1000 + len(PDF) * 3
        with patch("pdf_history.shutil.disk_usage", return_value=SimpleNamespace(free=threshold - 1)):
            self.assert_status(507, self.save)
            self.assertEqual(self.store.get(existing["id"])[0], PDF)
            self.assertEqual(self.store.list()["total"], 1)
        with patch("pdf_history.shutil.disk_usage", return_value=SimpleNamespace(free=threshold)):
            self.save()
        self.assertEqual(self.store.list()["total"], 2)

    def test_sqlite_connection_failure_never_returns_success(self):
        existing = self.save()
        with patch.object(self.store, "connect", side_effect=sqlite3.OperationalError("synthetic unavailable database")):
            self.assert_status(503, self.save)
        self.assertEqual(self.store.list()["total"], 1)
        self.assertEqual(self.store.get(existing["id"])[0], PDF)

    def test_sqlite_failure_after_insert_rolls_back_blob_and_metadata_together(self):
        existing = self.save()
        with closing(sqlite3.connect(self.store.path)) as db, db:
            db.execute("CREATE TRIGGER synthetic_abort AFTER INSERT ON documents BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END")
        self.assert_status(503, self.save)
        with closing(sqlite3.connect(self.store.path)) as db:
            self.assertEqual(db.execute("SELECT count(*), sum(length(pdf)) FROM documents").fetchone(), (1, len(PDF)))
        self.assertEqual(self.store.list()["items"], [existing])
        self.assertEqual(self.store.get(existing["id"])[0], PDF)

    def test_invalid_query_and_page_filters_are_rejected(self):
        for query in (None, False, 0, [], {}, "x" * 161):
            with self.subTest(query=query):
                self.assert_status(400, self.store.list, q=query)
        for page in (None, True, False, 0, -1, 1.0, "", "01", "1.0", "1e2", "1 OR 1=1", 10000000):
            with self.subTest(page=page):
                self.assert_status(400, self.store.list, page=page)

    def test_invalid_dates_and_reversed_range_are_rejected(self):
        for field in ("date_from", "date_to"):
            for value in ("2026-02-30", "2025-02-29", "2026-13-01", "2026-00-01", "2026-1-01",
                          "15/10/2026", "2026-10-15T00:00:00Z", "2026-10-15\n", "2026-10-15' OR 1=1", None, False, 0, [], {}):
                with self.subTest(field=field, value=value):
                    self.assert_status(400, self.store.list, **{field: value})
        self.assert_status(400, self.store.list, date_from="2026-10-16", date_to="2026-10-15")
        self.assertEqual(self.store.list(date_from="2024-02-29")["total"], 0)

    def test_invalid_pdf_or_result_metadata_cannot_be_saved(self):
        for pdf in (b"", b"not a PDF", b"%PDF-" + b"x" * (20 * 1024 * 1024)):
            with self.subTest(size=len(pdf)):
                self.assert_status(422, self.store.save, pdf, total=1, pages=[1])
        for overrides in ({"total": True, "pages": [1]}, {"total": 0}, {"total": 301}, {"total": 1.0},
                          {"pages": []}, {"pages": [0]}, {"pages": [17]}, {"pages": [3, 3]},
                          {"pages": [True]}, {"pages": ["3"]}, {"pages": (3, 8)}):
            with self.subTest(overrides=overrides):
                self.assert_status(422, self.save, **overrides)
        self.assertEqual(self.store.list()["total"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
