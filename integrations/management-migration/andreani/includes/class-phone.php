<?php
defined('ABSPATH') || exit;

class FBAM_Phone {
    private static function metadata() {
        static $data;
        if ($data === null) {
            $data = json_decode(file_get_contents(FBAM_PATH . 'data/argentina-phone.json'), true);
            if (!is_array($data)) { $data = ['area_codes'=>[], 'formats'=>[]]; }
        }
        return $data;
    }

    private static function split_national($digits) {
        if (!preg_match('/^\d{10}$/D', $digits)) { return []; }
        $data = self::metadata();
        // Follow the ordered geographic formats; overlapping area codes cannot
        // be resolved safely by blindly taking the first three/four digits.
        foreach ($data['formats'] as $format) {
            if (!preg_match('~^(?:' . $format['leading'] . ')~', $digits)) { continue; }
            if (preg_match('~^' . $format['pattern'] . '$~D', $digits, $m) && in_array($m[1], $data['area_codes'], true)) {
                return ['code'=>$m[1], 'number'=>substr($digits,strlen($m[1]))];
            }
        }
        return [];
    }

    public static function split($raw) {
        if (!is_scalar($raw)) { return []; }
        $raw = trim((string) $raw);
        // Reject multiple phone numbers, extensions and letters, rather than
        // concatenating them into a different person's number.
        if ($raw === '' || !preg_match('/^\+?[\d\s().-]+$/uD', $raw)) { return []; }
        $digits = preg_replace('/\D/', '', $raw);
        if (strpos($raw, '+') === 0) {
            if (substr($digits,0,2) !== '54') { return []; }
            $digits = substr($digits,2);
        } elseif (substr($digits,0,2) === '00') {
            if (substr($digits,0,4) !== '0054') { return []; }
            $digits = substr($digits,4);
        } elseif (substr($digits,0,2) === '54' && strlen($digits) >= 12) {
            $digits = substr($digits,2);
        }
        if (substr($digits,0,1) === '0' && in_array(strlen($digits), [11,13], true)) { $digits = substr($digits,1); }
        if (strlen($digits) === 11 && substr($digits,0,1) === '9') { $digits = substr($digits,1); }
        if (strlen($digits) === 10) { return self::split_national($digits); }
        if (strlen($digits) !== 12) { return []; }
        // Domestic mobile notation: area code + 15 + local number.
        $candidates = [];
        foreach (self::metadata()['area_codes'] as $code) {
            if (strpos($digits,$code.'15') !== 0) { continue; }
            $normalized = $code . substr($digits,strlen($code)+2);
            $split = self::split_national($normalized);
            if ($split && $split['code'] === $code) { $candidates[$normalized] = $split; }
        }
        return count($candidates) === 1 ? reset($candidates) : [];
    }
}
