"""Focused PDF regression tests. Fixtures contain synthetic text, never label PII.

Run: python -X utf8 pdf-corrector.test.py
Optional real-file verification: set PDF_CORRECTOR_SAMPLE to a local source PDF.
Regenerate synthetic font fixture: python pdf-corrector.test.py --build-fixture source.pdf
"""
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

from pdf_corrector import CorrectionError, correct_pdf, font_maps, image_hashes
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, ContentStream, DecodedStreamObject, DictionaryObject,
                           FloatObject, NameObject, NumberObject)

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "tests" / "labels.pdf"
OLD = ("Peso: 9000 Gr // Ancho: 20 Cm", "Alto: 30 Cm // Largo: 40 Cm")
NEW = ("Peso: 15000 Gr // Ancho: 25 Cm", "Alto: 70 Cm // Largo: 150 Cm")
DEFAULT_SETTINGS = {
    "before": {"weight": "9000", "width": "20", "height": "30", "length": "40"},
    "after": {"weight": "15000", "width": "25", "height": "70", "length": "150"},
}
UNSET = object()


def rule_lines(values):
    return (f"Peso: {values['weight']} Gr // Ancho: {values['width']} Cm",
            f"Alto: {values['height']} Cm // Largo: {values['length']} Cm")


def font_widths(page):
    values = page["/Resources"]["/Font"]["/F6"]["/DescendantFonts"][0].get_object()["/W"]
    assert len(values) == 2 and int(values[0]) == 0
    return [float(value) * 12 / 1000 for value in values[1]]


def text_stream(lines, mapping, widths, compact=False, array_operator=False):
    reverse = {value: key for key, value in mapping.items()}
    out = ["q 12 0 0 12 250 250 cm /QAImage Do Q"]
    for row, line in enumerate(lines):
        glyphs = [reverse[char].to_bytes(2, "big").hex() for char in line]
        out.append(f"BT /F6 12 Tf 1 0 0 1 20 {220-row*22} Tm 0 0 Td")
        if array_operator:
            out.append("[<" + "".join(glyphs) + ">] TJ")
        elif compact:
            out.append("<" + "".join(glyphs) + "> Tj")
        else:
            pieces = []
            for i, glyph in enumerate(glyphs):
                pieces.append("<" + glyph + "> Tj")
                if i != len(glyphs) - 1:
                    pieces.append(f"{widths[int(glyph, 16)]:.6f} 0 Td")
            out.append(" ".join(pieces))
        out.append("ET")
    return ("\n".join(out) + "\n").encode("ascii")


def make_pdf(pages=(OLD,), *, compact=False, array_operator=False,
             unsupported_font=False, encrypted=False):
    base = PdfReader(FIXTURE)
    mapping = font_maps(base.pages[0])["/F6"]
    writer = PdfWriter()
    for lines in pages:
        page = writer.add_page(copy.deepcopy(base.pages[0]))
        stream = DecodedStreamObject()
        stream.set_data(text_stream(lines, mapping, font_widths(base.pages[0]), compact, array_operator))
        page[NameObject("/Contents")] = writer._add_object(stream)
        if unsupported_font:
            page["/Resources"]["/Font"][NameObject("/Unsupported")] = DictionaryObject({
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            })
    if encrypted:
        writer.encrypt("synthetic-test-password")
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def synthetic_line_bounds(page, reader):
    """Measure glyph extents from PDF text positions in the synthetic horizontal fixture."""
    widths = font_widths(page)
    bounds = []
    points = []
    line_x = line_y = text_x = text_y = 0
    matrix = [1, 0, 0, 1, 0, 0]
    for args, operator in ContentStream(page.get_contents(), reader).operations:
        if operator == b"BT":
            points = []
        elif operator == b"Tm":
            matrix = [float(item) for item in args]
            line_x = line_y = text_x = text_y = 0
        elif operator == b"Td":
            line_x += float(args[0])
            line_y += float(args[1])
            text_x, text_y = line_x, line_y
        elif operator == b"Tj":
            value = args[0]
            raw = value.original_bytes if hasattr(value, "original_bytes") else bytes(value)
            for offset in range(0, len(raw), 2):
                advance = widths[int.from_bytes(raw[offset:offset + 2], "big")]
                points.append((matrix[0] * text_x + matrix[2] * text_y + matrix[4],
                               matrix[1] * text_x + matrix[3] * text_y + matrix[5]))
                text_x += advance
                points.append((matrix[0] * text_x + matrix[2] * text_y + matrix[4],
                               matrix[1] * text_x + matrix[3] * text_y + matrix[5]))
        elif operator == b"ET" and points:
            bounds.append({"anchor": points[0], "left": min(p[0] for p in points),
                           "right": max(p[0] for p in points), "baseline": points[0][1]})
    return bounds


def build_fixture(source):
    """Copy only a font object; use a blank page, synthetic image and new content."""
    reader = PdfReader(source)
    mapping = font_maps(reader.pages[0])["/F6"]
    writer = PdfWriter()
    page = writer.add_blank_page(width=350, height=300)
    font = reader.pages[0]["/Resources"]["/Font"]["/F6"].clone(writer)
    image = DecodedStreamObject()
    image.update({NameObject("/Type"): NameObject("/XObject"),
                  NameObject("/Subtype"): NameObject("/Image"),
                  NameObject("/Width"): NumberObject(2),
                  NameObject("/Height"): NumberObject(2),
                  NameObject("/ColorSpace"): NameObject("/DeviceGray"),
                  NameObject("/BitsPerComponent"): NumberObject(8)})
    image.set_data(bytes([0, 255, 255, 0]))
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F6"): font}),
        NameObject("/XObject"): DictionaryObject({NameObject("/QAImage"): writer._add_object(image)}),
    })
    stream = DecodedStreamObject()
    stream.set_data(text_stream(OLD, mapping, font_widths(reader.pages[0])))
    page[NameObject("/Contents")] = writer._add_object(stream)
    FIXTURE.parent.mkdir(exist_ok=True)
    with FIXTURE.open("wb") as output:
        writer.write(output)
    assert PdfReader(FIXTURE).pages[0].extract_text().splitlines() == list(OLD)


class CorrectorTests(unittest.TestCase):
    def cli(self, source, settings=UNSET, raw_settings=UNSET):
        command = [sys.executable, "-X", "utf8", str(HERE / "pdf_corrector.py")]
        if raw_settings is not UNSET:
            command.append(raw_settings)
        elif settings is not UNSET:
            command.append(json.dumps(settings))
        result = subprocess.run(command,
                                input=source, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        header, separator, document = result.stdout.partition(b"\n")
        self.assertTrue(separator)
        return json.loads(header), document

    def assert_cli_rejected(self, source, status=422, settings=UNSET, raw_settings=UNSET):
        result, document = self.cli(source, settings=settings, raw_settings=raw_settings)
        self.assertEqual(result["ok"], False)
        self.assertEqual(result["status"], status)
        self.assertIsInstance(result["message"], str)
        self.assertEqual(document, b"", "A rejected upload must not expose partial output")

    def test_exact_pair_preserves_other_pages_images_size_rotation_and_source(self):
        pages = (OLD, ("Peso: 15000 Gr // Ancho: 20 Cm", OLD[1]), OLD)
        source = make_pdf(pages)
        untouched_source = bytes(source)
        data, info = correct_pdf(source)
        self.assertEqual(source, untouched_source)
        self.assertEqual(info, {"total": 3, "pages": [1, 3]})
        before, after = PdfReader(io.BytesIO(source)), PdfReader(io.BytesIO(data))
        self.assertEqual(len(after.pages), 3)
        for i, (first, second) in enumerate(zip(before.pages, after.pages)):
            expected = first.extract_text()
            if i != 1:
                for old, new in zip(OLD, NEW):
                    expected = expected.replace(old, new)
            self.assertEqual(second.extract_text(), expected)
            self.assertEqual(tuple(first.mediabox), tuple(second.mediabox))
            self.assertEqual(first.rotation, second.rotation)
            self.assertEqual(image_hashes(first), image_hashes(second))
        self.assertEqual(before.pages[1].get_contents().get_data(), after.pages[1].get_contents().get_data())

    def test_no_match_already_corrected_and_partial_pairs_are_rejected(self):
        for pages in [(("15000",),), (NEW,), ((OLD[0],),), ((OLD[1],),),
                      ((OLD[0],), (OLD[1],))]:
            with self.subTest(pages=pages):
                with self.assertRaises(CorrectionError):
                    correct_pdf(make_pdf(pages))

    def test_second_application_does_not_generate_a_second_modified_pdf(self):
        data, _ = correct_pdf(make_pdf())
        with self.assertRaises(CorrectionError):
            correct_pdf(data)

    def test_empty_and_non_pdf_are_400_and_oversized_is_413(self):
        for data, status in [(b"", 400), (b"not a pdf", 400), (b"%PDF-" + b"x" * (10 * 1024 * 1024), 413)]:
            with self.subTest(status=status, size=len(data)):
                self.assert_cli_rejected(data, status)

    def test_malformed_pdf_and_password_protected_pdf_return_no_output(self):
        self.assert_cli_rejected(b"%PDF-1.7\ntruncated")
        self.assert_cli_rejected(make_pdf(encrypted=True))

    def test_300_pages_allowed_but_301_and_zero_rejected(self):
        data, info = correct_pdf(make_pdf((OLD,) + (("15000",),) * 299))
        self.assertEqual(info, {"total": 300, "pages": [1]})
        self.assertEqual(len(PdfReader(io.BytesIO(data)).pages), 300)
        for pages in [(), (("15000",),) * 301]:
            with self.assertRaises(CorrectionError) as error:
                correct_pdf(make_pdf(pages))
            self.assertEqual(error.exception.status, 413)

    def test_unsupported_font_or_layout_fails_without_partial_output(self):
        for options in [{"compact": True}, {"array_operator": True}, {"unsupported_font": True}]:
            with self.subTest(options=options):
                self.assert_cli_rejected(make_pdf(**options))

    def test_duplicate_matching_blocks_are_rejected(self):
        self.assert_cli_rejected(make_pdf((OLD + OLD,)))

    def test_later_invalid_page_cannot_expose_an_earlier_partial_correction(self):
        writer = PdfWriter()
        for compact in (False, True):
            reader = PdfReader(io.BytesIO(make_pdf(compact=compact)))
            writer.add_page(reader.pages[0])
        source = io.BytesIO()
        writer.write(source)
        self.assert_cli_rejected(source.getvalue())

    def test_indirect_empty_annotations_are_allowed_but_real_annotations_rejected(self):
        for nonempty in (False, True):
            with self.subTest(nonempty=nonempty):
                reader = PdfReader(io.BytesIO(make_pdf()))
                writer = PdfWriter()
                writer.clone_document_from_reader(reader)
                annotations = ArrayObject()
                if nonempty:
                    annotations.append(DictionaryObject({NameObject("/Subtype"): NameObject("/Text")}))
                writer.pages[0][NameObject("/Annots")] = writer._add_object(annotations)
                source = io.BytesIO()
                writer.write(source)
                if nonempty:
                    self.assert_cli_rejected(source.getvalue())
                else:
                    _, info = correct_pdf(source.getvalue())
                    self.assertEqual(info, {"total": 1, "pages": [1]})

    def test_cli_success_is_json_header_followed_by_pdf(self):
        info, document = self.cli(make_pdf())
        self.assertEqual(info, {"ok": True, "total": 1, "pages": [1]})
        self.assertTrue(document.startswith(b"%PDF-"))
        self.assertEqual(PdfReader(io.BytesIO(document)).pages[0].extract_text().splitlines(), list(NEW))

    def test_none_and_explicit_default_settings_preserve_original_behavior(self):
        source = make_pdf()
        for settings in (None, copy.deepcopy(DEFAULT_SETTINGS)):
            with self.subTest(settings=settings):
                output, info = correct_pdf(source, settings)
                self.assertEqual(info, {"total": 1, "pages": [1]})
                self.assertEqual(PdfReader(io.BytesIO(output)).pages[0].extract_text().splitlines(), list(NEW))

    def test_custom_rule_requires_all_four_values_and_preserves_unmatched_pages(self):
        settings = {
            "before": {"weight": "12345", "width": "12", "height": "34", "length": "56"},
            "after": {"weight": "67890", "width": "65", "height": "43", "length": "21"},
        }
        match = rule_lines(settings["before"])
        pages = (OLD, match,
                 rule_lines({**settings["before"], "height": "35"}),
                 rule_lines({**settings["before"], "weight": "12346"}),
                 (match[0],), (match[1],), match)
        source = make_pdf(pages)
        settings_before = copy.deepcopy(settings)
        output, info = correct_pdf(source, settings)
        self.assertEqual(settings, settings_before, "The request settings must not be mutated")
        self.assertEqual(info, {"total": 7, "pages": [2, 7]})
        original, corrected = PdfReader(io.BytesIO(source)), PdfReader(io.BytesIO(output))
        for i, (before, after) in enumerate(zip(original.pages, corrected.pages), 1):
            if i in (2, 7):
                self.assertEqual(after.extract_text().splitlines(), list(rule_lines(settings["after"])))
            else:
                self.assertEqual(before.get_contents().get_data(), after.get_contents().get_data())
                self.assertEqual(before.extract_text(), after.extract_text())
            self.assertEqual(tuple(before.mediabox), tuple(after.mediabox))
            self.assertEqual(before.rotation, after.rotation)
            self.assertEqual(image_hashes(before), image_hashes(after))

    def test_each_field_can_change_individually_including_one_unchanged_line(self):
        source = make_pdf()
        for field, value in {"weight": "800", "width": "21", "height": "31", "length": "41"}.items():
            with self.subTest(field=field):
                settings = {"before": copy.deepcopy(DEFAULT_SETTINGS["before"]),
                            "after": {**DEFAULT_SETTINGS["before"], field: value}}
                output, info = correct_pdf(source, settings)
                self.assertEqual(info, {"total": 1, "pages": [1]})
                self.assertEqual(PdfReader(io.BytesIO(output)).pages[0].extract_text().splitlines(), list(rule_lines(settings["after"])))

    def test_minimum_and_maximum_digit_lengths_can_grow_and_shrink(self):
        small = {"weight": "1", "width": "1", "height": "1", "length": "1"}
        large = {"weight": "999999", "width": "9999", "height": "9999", "length": "9999"}
        for before, after in ((small, large), (large, small)):
            with self.subTest(before=before):
                output, info = correct_pdf(make_pdf((rule_lines(before),)), {"before": before, "after": after})
                self.assertEqual(info, {"total": 1, "pages": [1]})
                self.assertEqual(PdfReader(io.BytesIO(output)).pages[0].extract_text().splitlines(), list(rule_lines(after)))

    def test_longer_manual_values_preserve_anchor_and_fit_with_nonzero_initial_td(self):
        settings = {"before": {"weight": "1", "width": "1", "height": "1", "length": "1"},
                    "after": {"weight": "999999", "width": "9999", "height": "9999", "length": "9999"}}
        reader = PdfReader(io.BytesIO(make_pdf((rule_lines(settings["before"]),))))
        writer = PdfWriter()
        writer.clone_document_from_reader(reader)
        page = writer.pages[0]
        content = ContentStream(page.get_contents(), writer)
        first_td = False
        for args, operator in content.operations:
            if operator == b"BT":
                first_td = True
            elif operator == b"Td" and first_td:
                args[0] = FloatObject(37.25)
                first_td = False
        page.replace_contents(content)
        source = io.BytesIO()
        writer.write(source)
        output, info = correct_pdf(source.getvalue(), settings)
        self.assertEqual(info, {"total": 1, "pages": [1]})
        before = PdfReader(io.BytesIO(source.getvalue()))
        after = PdfReader(io.BytesIO(output))
        expected_text = before.pages[0].extract_text()
        for old_line, new_line in zip(rule_lines(settings["before"]), rule_lines(settings["after"])):
            expected_text = expected_text.replace(old_line, new_line)
        self.assertEqual(after.pages[0].extract_text(), expected_text)
        original_bounds = synthetic_line_bounds(before.pages[0], before)
        changed_bounds = synthetic_line_bounds(after.pages[0], after)
        self.assertEqual(len(original_bounds), 2)
        self.assertEqual(len(changed_bounds), 2)
        for original, changed in zip(original_bounds, changed_bounds):
            self.assertAlmostEqual(original["anchor"][0], changed["anchor"][0], places=5)
            self.assertAlmostEqual(original["anchor"][1], changed["anchor"][1], places=5)
            self.assertAlmostEqual(original["left"], changed["left"], places=5)
            self.assertLessEqual(changed["right"], original["right"] + 1e-5,
                                 "Growing a number must not overwrite content to the right")

    def test_custom_no_match_partial_match_and_repeat_return_no_modified_output(self):
        settings = copy.deepcopy(DEFAULT_SETTINGS)
        settings["before"]["weight"] = "9876"
        for pages in ((OLD,), (rule_lines(settings["after"]),),
                      ((rule_lines(settings["before"])[0],), (rule_lines(settings["before"])[1],))):
            with self.subTest(pages=pages):
                self.assert_cli_rejected(make_pdf(pages), settings=settings)
        first, _ = correct_pdf(make_pdf((rule_lines(settings["before"]),)), settings)
        self.assert_cli_rejected(first, settings=settings)

    def test_settings_reject_wrong_shape_types_extra_keys_and_identical_values(self):
        source = make_pdf()
        invalid = [{}, [], True, False, 1, "default",
                   {"before": DEFAULT_SETTINGS["before"]},
                   {"after": DEFAULT_SETTINGS["after"]},
                   {**DEFAULT_SETTINGS, "extra": "rejected"},
                   {"before": DEFAULT_SETTINGS["before"], "after": DEFAULT_SETTINGS["before"]}]
        for side in ("before", "after"):
            for wrong in (None, {}, [], "9000", True, 9):
                invalid.append({**copy.deepcopy(DEFAULT_SETTINGS), side: wrong})
            invalid.append({**copy.deepcopy(DEFAULT_SETTINGS), side: {**DEFAULT_SETTINGS[side], "extra": "1"}})
            for field in ("weight", "width", "height", "length"):
                missing = copy.deepcopy(DEFAULT_SETTINGS)
                del missing[side][field]
                invalid.append(missing)
        for settings in invalid:
            with self.subTest(settings=settings):
                with self.assertRaises(CorrectionError) as error:
                    correct_pdf(source, settings)
                self.assertEqual(error.exception.status, 400)

    def test_settings_accept_only_positive_ascii_integer_strings_with_field_limits(self):
        source = make_pdf()
        bad_values = ("", None, True, False, 1, 1.2, [], {}, "0", "-1", "+1", "1.5",
                      "1,5", "1e2", " 1", "1 ", "1\n", "١", "１", "1 Gr", "<1>")
        for side in ("before", "after"):
            for field in ("weight", "width", "height", "length"):
                for bad in (*bad_values, "1" * (7 if field == "weight" else 5)):
                    with self.subTest(side=side, field=field, value=bad):
                        settings = copy.deepcopy(DEFAULT_SETTINGS)
                        settings[side][field] = bad
                        with self.assertRaises(CorrectionError) as error:
                            correct_pdf(source, settings)
                        self.assertEqual(error.exception.status, 400)

    def test_cli_receives_custom_settings_as_json_argument_and_rejects_bad_json(self):
        settings = {"before": copy.deepcopy(DEFAULT_SETTINGS["before"]),
                    "after": {**DEFAULT_SETTINGS["before"], "length": "1"}}
        info, document = self.cli(make_pdf(), settings=settings)
        self.assertEqual(info, {"ok": True, "total": 1, "pages": [1]})
        self.assertEqual(PdfReader(io.BytesIO(document)).pages[0].extract_text().splitlines(), list(rule_lines(settings["after"])))
        for raw in ("{", "", "[]", "true", "{}"):
            with self.subTest(raw=raw):
                self.assert_cli_rejected(make_pdf(), 400, raw_settings=raw)
        settings["after"]["length"] = 1
        self.assert_cli_rejected(make_pdf(), 400, settings=settings)

    @unittest.skipUnless(os.environ.get("PDF_CORRECTOR_SAMPLE"), "Set PDF_CORRECTOR_SAMPLE for real-file verification")
    def test_real_source_opt_in(self):
        source = Path(os.environ["PDF_CORRECTOR_SAMPLE"]).read_bytes()
        reader = PdfReader(io.BytesIO(source))
        expected = [i + 1 for i, page in enumerate(reader.pages) if all(old in page.extract_text() for old in OLD)]
        document, info = correct_pdf(source)
        self.assertEqual(info, {"total": len(reader.pages), "pages": expected})
        self.assertEqual(len(PdfReader(io.BytesIO(document)).pages), len(reader.pages))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--build-fixture":
        build_fixture(sys.argv[2])
        print("Synthetic fixture created without source page content")
    else:
        unittest.main(verbosity=2)
