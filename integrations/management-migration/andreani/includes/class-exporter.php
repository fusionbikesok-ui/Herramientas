<?php
defined('ABSPATH') || exit;

class FBAM_Exporter {
    public static function generate($groups) {
        if (!class_exists('ZipArchive') || !class_exists('DOMDocument')) { throw new RuntimeException('El servidor necesita las extensiones PHP zip y dom para generar el Excel.'); }
        $path = wp_tempnam('fusion-andreani.xlsx');
        if (!$path || !copy(FBAM_PATH . 'data/EnvioMasivoExcelPaquetes.xlsx', $path)) { throw new RuntimeException('No se pudo crear el archivo temporal.'); }
        $zip = new ZipArchive();
        try {
            if ($zip->open($path) !== true) { throw new RuntimeException('No se pudo abrir la plantilla Excel.'); }
            $ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
            foreach (['home'=>1,'branch'=>2,'today'=>3] as $service=>$sheet) {
                $rows = $groups[$service] ?? [];
                if (count($rows) > 497) { throw new RuntimeException('La plantilla admite 497 filas por hoja. Dividí la exportación.'); }
                $entry = 'xl/worksheets/sheet' . $sheet . '.xml';
                $doc = new DOMDocument();
                if (!$doc->loadXML($zip->getFromName($entry), LIBXML_NONET)) { throw new RuntimeException('La plantilla contiene una hoja inválida.'); }
                $data = $doc->getElementsByTagNameNS($ns, 'sheetData')->item(0);
                if (!$data) { throw new RuntimeException('No se encontró la tabla de la plantilla.'); }
                // Preserve every other part: header rows, styles, validations, hidden configuration and sheet names.
                foreach (iterator_to_array($data->childNodes) as $child) {
                    if ($child instanceof DOMElement && (int) $child->getAttribute('r') >= 3) { $data->removeChild($child); }
                }
                foreach ($rows as $index=>$values) {
                    $r = $index + 3;
                    $row = $doc->createElementNS($ns, 'x:row');
                    $row->setAttribute('r', (string) $r);
                    foreach ($values as $col=>$value) {
                        $cell = $doc->createElementNS($ns, 'x:c');
                        $cell->setAttribute('r', chr(65 + $col) . $r);
                        // Only physical measurements and declared values are numeric. Identifiers remain text.
                        if ($col >= 1 && $col <= 5 && $value !== '') {
                            $v = $doc->createElementNS($ns, 'x:v');
                            $v->appendChild($doc->createTextNode((string) $value));
                            $cell->appendChild($v);
                        } else {
                            $cell->setAttribute('t', 'inlineStr');
                            $is = $doc->createElementNS($ns, 'x:is');
                            $text = $doc->createElementNS($ns, 'x:t');
                            $text->setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
                            $clean = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/u', '', (string) $value);
                            $text->appendChild($doc->createTextNode($clean ?? ''));
                            $is->appendChild($text);
                            $cell->appendChild($is);
                        }
                        $row->appendChild($cell);
                    }
                    $data->appendChild($row);
                }
                $dimension = $doc->getElementsByTagNameNS($ns, 'dimension')->item(0);
                if ($dimension) { $dimension->setAttribute('ref', 'A1:' . ($service === 'branch' ? 'N' : 'S') . max(2, count($rows)+2)); }
                if (!$zip->addFromString($entry, $doc->saveXML())) { throw new RuntimeException('No se pudo escribir una hoja del Excel.'); }
            }
            if (!$zip->close()) { throw new RuntimeException('No se pudo cerrar el Excel.'); }
            return $path;
        } catch (Throwable $e) {
            @$zip->close();
            @unlink($path);
            throw $e;
        }
    }
}
