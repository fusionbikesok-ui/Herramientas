<?php
/**
 * Bridge a Master Control: consulta segura de configuración y validaciones.
 * Proporciona métodos para detectar disponibilidad del plugin y acceder a datos compartidos.
 */
if (!defined('ABSPATH')) exit;

class FBPOS_Master_Control_Bridge {
    /**
     * Verifica si el plugin Master Control está disponible y activo.
     */
    public function is_available(): bool {
        return class_exists('FusionBikes\\MasterControl\\Services\\DataService');
    }

    /**
     * Retorna la lista de cuotas permitidas para Mercado Pago.
     * Válidas: 3, 6, 9, 12, 18, 24 (como strings).
     * Si Master Control no está disponible, retorna array vacío.
     */
    public function get_allowed_installments(): array {
        if (!$this->is_available()) {
            return [];
        }

        try {
            $data_service = new \FusionBikes\MasterControl\Services\DataService();
            return $data_service->getAllAllowedTypes();
        } catch (Throwable $e) {
            return [];
        }
    }

    /**
     * Valida que una cuota sea una de las permitidas.
     * Retorna true si es válida (está en la lista permitida).
     * Retorna false si no es válida o si Master Control no está disponible.
     */
    public function is_valid_installment($installments): bool {
        if (null === $installments || '' === $installments) {
            return false;
        }

        $allowed = $this->get_allowed_installments();
        if (empty($allowed)) {
            return false;
        }

        $installments_str = (string) $installments;
        return in_array($installments_str, $allowed, true);
    }

    /**
     * Normaliza una cuota a su representación string si es válida.
     * Retorna la cuota normalizada (ej: '3', '12') o null si no es válida.
     */
    public function normalize_installment($installments): ?string {
        if (!$this->is_valid_installment($installments)) {
            return null;
        }

        return (string) $installments;
    }

    /**
     * Obtiene el coeficiente global real de Master Control para una cantidad de cuotas.
     * Usa productId=0 para obtener el coeficiente GLOBAL (sin excepciones por producto específico).
     * Retorna null si Master Control no está disponible o la cuota no es válida.
     */
    public function get_coefficient(string $installments): ?float {
        if (!$this->is_valid_installment($installments)) {
            return null;
        }

        try {
            $data_service = new \FusionBikes\MasterControl\Services\DataService();
            $coefficient = (float) $data_service->getCoefficient(0, $installments);
            return $coefficient > 0 ? $coefficient : null;
        } catch (Throwable $e) {
            return null;
        }
    }

    /**
     * Obtiene todos los coeficientes globales reales, indexados por cuota.
     * Ej: ['3' => 1.10, '6' => 1.25, '9' => 1.35, ...]
     * Si Master Control no está disponible, retorna array vacío.
     */
    public function get_all_coefficients(): array {
        $out = [];
        foreach ($this->get_allowed_installments() as $installment) {
            $coefficient = $this->get_coefficient($installment);
            if ($coefficient !== null) {
                $out[$installment] = $coefficient;
            }
        }
        return $out;
    }

    /**
     * Retorna cuotas permitidas para Posnet (SIN 24 cuotas).
     * Válidas: 3, 6, 9, 12, 18 (como strings).
     */
    public function get_allowed_installments_posnet(): array {
        $all = $this->get_allowed_installments();
        if (empty($all)) {
            return [];
        }

        // Filtrar: excluir '24'. array_values() reindexa — array_filter() conserva las
        // claves originales, y como acá se está sacando el último elemento de una lista
        // secuencial, wp_localize_script() lo serializaría como objeto JS ({"0":...})
        // en vez de array apenas el orden de origen cambie, rompiendo el selector de
        // cuotas de Posnet en el frontend sin ningún error visible (revisor).
        return array_values(array_filter($all, function($inst) {
            return (string) $inst !== '24';
        }));
    }

    /**
     * Valida que una cuota sea válida para Posnet (sin 24 cuotas).
     */
    public function is_valid_installment_posnet($installments): bool {
        if (null === $installments || '' === $installments) {
            return false;
        }

        $allowed = $this->get_allowed_installments_posnet();
        if (empty($allowed)) {
            return false;
        }

        $installments_str = (string) $installments;
        return in_array($installments_str, $allowed, true);
    }

    /**
     * Obtiene coeficientes para Posnet (sin 24 cuotas).
     */
    public function get_all_coefficients_posnet(): array {
        $out = [];
        foreach ($this->get_allowed_installments_posnet() as $installment) {
            $coefficient = $this->get_coefficient($installment);
            if ($coefficient !== null) {
                $out[$installment] = $coefficient;
            }
        }
        return $out;
    }
}
