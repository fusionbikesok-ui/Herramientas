<?php
defined('ABSPATH') || exit;

class FBAM_Address {
    public static function notes($first, $second) {
        $first = FBAM_Data::text($first);
        $second = FBAM_Data::text($second);
        if ($first === '') { return $second; }
        if ($second === '') { return $first; }
        // A previously separated complement may already be in observations.
        $pieces = preg_split('/\s*;\s*/u', $second);
        foreach ($pieces as $piece) {
            if (FBAM_Data::norm($piece) === FBAM_Data::norm($first)) { return $second; }
        }
        return $first . '; ' . $second;
    }

    public static function split($line) {
        $line = trim(preg_replace('/\s+/u', ' ', FBAM_Data::text($line)));
        if ($line === '') { return []; }
        // Rural addresses, intersections and addresses without a civic number
        // must be resolved by the operator rather than guessing a civic number.
        if (preg_match('~\b(?:km|kil[oó]metros?|ruta|rutas)\b|\bs\s*/\s*n\b|\bsin\s+n[uú]mero\b~iu', $line)) { return []; }
        $marker = '(?:barrio\b|b[º°]|piso\b|dpto\b|depto\b|departamento\b|planta\s+baja\b|pb\b|entre\b|referencia\b|manzana\b|mz\b|mza\b|lote\b|casa\b|torre\b|block\b|bloque\b)';
        $label = '(?:n[º°]\s*|nro\.?\s*|n[uú]mero\s*|numero\s*)?';
        // Anchor the suffix to a known complement. Street names can contain
        // numbers (9 de Julio, Calle 12); unknown trailing text is not discarded.
        $pattern = '~^(.+?)\s+' . $label . '(\d{1,6}[A-Za-z]?)(?:(?:\s*[,;]\s*|\s+)(' . $marker . '.*))?$~iu';
        if (!preg_match($pattern, $line, $m)) { return []; }
        $street = trim($m[1], " \t\n\r\0\x0B,");
        $norm = FBAM_Data::norm($street);
        if (in_array($norm, ['CALLE','AVENIDA','AV.','AV','PASAJE','PJE.','PJE'], true) || preg_match('/(?:\sY|\sENTRE|\sESQ\.?|\sESQUINA)$/', $norm)) { return []; }
        // Multiple unlabelled numbers can be a street number followed by an
        // apartment. Only accept familiar numbered/date street names here.
        $numbered_street = '~^(?:(?:av(?:enida)?\.?|calle|diagonal|diag\.?|pasaje|pje\.?|boulevard|bulevar|bv\.?)\s+)?\d{1,4}(?:\s+de\s+\p{L}+(?:\s+de\s+\d{4})?)?$~iu';
        if (preg_match('/\d/', $street) && !preg_match($numbered_street, $street)) { return []; }
        if (!preg_match('/[\p{L}\p{N}]/u', $street)) { return []; }
        return ['street'=>$street, 'number'=>$m[2], 'observations'=>trim($m[3] ?? '')];
    }
}
