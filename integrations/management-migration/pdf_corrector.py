"""Apply the exact two-line rule to this Andreani PDF, preserving embedded fonts.

Fails closed on unsupported text layout. Never overwrites the input file.
"""
from __future__ import annotations

import io
import copy
import sys
import difflib
import hashlib
import json
import re
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "worker" / "pypdf-vendor.zip"))
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ByteStringObject, ContentStream, FloatObject

RULES = {
    "Peso: 9000 Gr // Ancho: 20 Cm": "Peso: 15000 Gr // Ancho: 25 Cm",
    "Alto: 30 Cm // Largo: 40 Cm": "Alto: 70 Cm // Largo: 150 Cm",
}


def build_rules(settings=None):
    if settings is None:
        return dict(RULES)
    invalid = "Completá entrada y salida con números enteros positivos: peso de hasta 6 dígitos y medidas de hasta 4."
    if not isinstance(settings, dict) or set(settings) != {"before", "after"}:
        raise CorrectionError(invalid, 400)
    keys = {"weight", "width", "height", "length"}
    for values in settings.values():
        if not isinstance(values, dict) or set(values) != keys:
            raise CorrectionError(invalid, 400)
        for key, value in values.items():
            limit = 6 if key == "weight" else 4
            if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1," + str(limit) + "}", value) or int(value) == 0:
                raise CorrectionError(invalid, 400)
    if settings["before"] == settings["after"]:
        raise CorrectionError("Cambiá al menos un valor de salida: entrada y salida son iguales.", 400)
    def lines(values):
        return (f"Peso: {values['weight']} Gr // Ancho: {values['width']} Cm",
                f"Alto: {values['height']} Cm // Largo: {values['length']} Cm")
    return dict(zip(lines(settings["before"]), lines(settings["after"])))


def font_maps(page):
    result = {}
    for name, ref in page["/Resources"]["/Font"].items():
        font = ref.get_object()
        if font.get("/Encoding") != "/Identity-H" or "/ToUnicode" not in font:
            raise ValueError("Unsupported font encoding")
        cmap = font["/ToUnicode"].get_data().decode("ascii")
        mapping = {}
        for match in re.finditer(
            r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^]]*)\]", cmap
        ):
            start = int(match[1], 16)
            values = re.findall(r"<([0-9A-Fa-f]+)>", match[3])
            assert len(values) == int(match[2], 16) - start + 1
            for offset, value in enumerate(values):
                mapping[start + offset] = bytes.fromhex(value).decode("utf-16-be")
        if not mapping:
            raise ValueError("Unsupported Unicode map")
        result[str(name)] = mapping
    return result


def decode(value, mapping):
    raw = value.original_bytes if hasattr(value, "original_bytes") else bytes(value)
    if len(raw) % 2:
        raise ValueError("Unexpected glyph encoding")
    return "".join(mapping.get(int.from_bytes(raw[i:i + 2], "big"), "\x00")
                   for i in range(0, len(raw), 2))


def find_blocks(content, maps, rules=None):
    rules = RULES if rules is None else rules
    start = None
    font = None
    text = ""
    blocks = []
    for index, (args, op) in enumerate(content.operations):
        if op == b"BT":
            start, text = index, ""
        elif op == b"Tf":
            font = str(args[0])
        elif op == b"Tj" and start is not None:
            text += decode(args[0], maps[font])
        elif op in (b"TJ", b"'", b'"') and start is not None:
            raise ValueError("Unsupported text operator")
        elif op == b"ET":
            if text in rules:
                blocks.append((start, index + 1, font, text))
            start = None
    return blocks


def replace_block(block, old, new, mapping):
    assert [op for args, op in block[:4]] == [b"BT", b"Tf", b"Tm", b"Td"]
    assert block[-1][1] == b"ET"
    body = block[4:-1]
    assert len(body) == 2 * len(old) - 1
    tokens = []
    advances = []
    for index, char in enumerate(old):
        args, op = body[2 * index]
        assert op == b"Tj" and decode(args[0], mapping) == char
        following = body[2 * index + 1] if index < len(old) - 1 else None
        if following:
            assert following[1] == b"Td" and float(following[0][1]) == 0
            if char.isdigit():
                advances.append(following)
        tokens.append(((args, op), following))
    assert advances and len({float(a[0][0]) for a in advances}) == 1
    digit_advance = advances[0]
    reverse = {v: k for k, v in mapping.items()}
    updated = []
    for tag, a, b, c, d in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes():
        if tag == "equal":
            updated.extend(tokens[a:b])
        else:
            assert all(ch.isdigit() for ch in old[a:b] + new[c:d])
            for ch in new[c:d]:
                glyph = ByteStringObject(reverse[ch].to_bytes(2, "big"))
                updated.append((([glyph], b"Tj"), digit_advance))
    operations = copy.deepcopy(block[:4])
    # Keep longer replacements inside the original line's horizontal footprint.
    old_width = sum(float(step[0][0]) for _, step in tokens if step is not None)
    new_width = sum(float(step[0][0]) for _, step in updated[:-1] if step is not None)
    if new_width > old_width:
        scale = old_width / new_width
        matrix = operations[2][0]
        initial_x = float(operations[3][0][0])
        matrix[4] = FloatObject(float(matrix[4]) + initial_x * float(matrix[0]) * (1 - scale))
        matrix[5] = FloatObject(float(matrix[5]) + initial_x * float(matrix[1]) * (1 - scale))
        matrix[0] = FloatObject(float(matrix[0]) * scale)
        matrix[1] = FloatObject(float(matrix[1]) * scale)
    for i, (glyph, following) in enumerate(updated):
        operations.append(glyph)
        if i < len(updated) - 1:
            assert following is not None
            operations.append(following)
    operations.append(block[-1])
    return operations


def image_hashes(page):
    xobjects = page["/Resources"].get("/XObject", {})
    return sorted(hashlib.sha256(ref.get_object().get_data()).hexdigest()
                  for ref in xobjects.values())


class CorrectionError(Exception):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def correct_pdf(source: bytes, settings=None):
    rules = build_rules(settings)
    if len(source) > 10 * 1024 * 1024:
        raise CorrectionError("El PDF supera los 10 MB.", 413)
    if not source.startswith(b"%PDF-"):
        raise CorrectionError("El archivo no es un PDF válido.", 400)
    reader = PdfReader(io.BytesIO(source))
    if reader.is_encrypted:
        raise CorrectionError("El PDF está protegido con contraseña. Subí una copia sin contraseña.")
    if not 1 <= len(reader.pages) <= 300:
        raise CorrectionError("El PDF debe tener entre 1 y 300 páginas.", 413)
    root = reader.trailer["/Root"]
    names = root.get("/Names", {})
    names = names.get_object() if hasattr(names, "get_object") else names
    if any(key in root for key in ["/AcroForm", "/OpenAction", "/AA"]) or any(key in names for key in ["/JavaScript", "/EmbeddedFiles"]):
        raise CorrectionError("Este PDF contiene formularios o acciones. Usá el PDF original de etiquetas de Andreani.")
    if any(page.get("/AA") or (page.get("/Annots").get_object() if page.get("/Annots") is not None else []) for page in reader.pages):
        raise CorrectionError("Este PDF contiene anotaciones. Usá el PDF original de etiquetas de Andreani.")
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    changed = []
    for index, page in enumerate(writer.pages):
        text = page.extract_text()
        if not all(old in text for old in rules):
            continue
        maps = font_maps(page)
        content = ContentStream(page.get_contents(), writer)
        blocks = find_blocks(content, maps, rules)
        if len(blocks) != 2 or {b[3] for b in blocks} != set(rules):
            raise CorrectionError("El diseño de las etiquetas es distinto al admitido. No se generó una copia modificada.")
        for start, end, font, old in reversed(blocks):
            replacement = replace_block(content.operations[start:end], old, rules[old], maps[font])
            content.operations[start:end] = replacement
        page.replace_contents(content)
        changed.append(index + 1)
    if not changed:
        raise CorrectionError("No hay etiquetas que coincidan con los cuatro datos de entrada. Revisá los valores o elegí otro PDF.")
    output = io.BytesIO()
    writer.write(output)
    data = output.getvalue()
    if len(data) > 20 * 1024 * 1024:
        raise CorrectionError("El resultado supera el tamaño permitido. Dividí el PDF en archivos más pequeños.", 413)
    result = PdfReader(io.BytesIO(data))
    assert len(result.pages) == len(reader.pages)
    for index, (before, after) in enumerate(zip(reader.pages, result.pages), 1):
        expected = before.extract_text()
        if index in changed:
            for old, new in rules.items():
                expected = expected.replace(old, new)
        assert after.extract_text() == expected
        assert tuple(before.mediabox) == tuple(after.mediabox)
        assert before.rotation == after.rotation
        assert image_hashes(before) == image_hashes(after)
        if index not in changed:
            assert before.get_contents().get_data() == after.get_contents().get_data()
    return data, {"total":len(result.pages), "pages":changed}


def main():
    if sys.platform == "linux":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (256*1024*1024, 256*1024*1024))
        resource.setrlimit(resource.RLIMIT_CPU, (22, 25))
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    try:
        settings = None
        if len(sys.argv) > 1:
            try:
                if len(sys.argv[1]) > 1024:
                    raise ValueError()
                settings = json.loads(sys.argv[1])
                if settings is None:
                    raise ValueError()
            except (ValueError, TypeError):
                raise CorrectionError("Los valores de reemplazo no son válidos.", 400)
        data, info = correct_pdf(sys.stdin.buffer.read(10*1024*1024+1), settings)
        sys.stdout.buffer.write(json.dumps({"ok":True, **info}).encode()+b"\n"+data)
    except CorrectionError as error:
        sys.stdout.buffer.write(json.dumps({"ok":False,"status":error.status,"message":str(error)},ensure_ascii=False).encode()+b"\n")
    except Exception:
        sys.stdout.buffer.write(json.dumps({"ok":False,"status":422,"message":"No se pudo verificar el formato de este PDF. Subí el archivo original de etiquetas de Andreani."},ensure_ascii=False).encode()+b"\n")


if __name__ == "__main__":
    main()
