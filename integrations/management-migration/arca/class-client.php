<?php
namespace FusionBikes\ARCA;
if (!defined('ABSPATH')) exit;
require_once __DIR__.'/class-diagnostics.php';

final class Client {
    private $env; private $cuit; private $soap; private $padronSoap;
    public function __construct(string $env, string $cuit) {
        $this->env = $env === 'production' ? 'production' : 'homologation'; $this->cuit = $cuit;
    }
    private function endpoints(): array {
        return $this->env === 'production'
            ? ['https://wsaa.afip.gov.ar/ws/services/LoginCms?WSDL','https://servicios1.afip.gov.ar/wsfev1/service.asmx?WSDL']
            : ['https://wsaahomo.afip.gov.ar/ws/services/LoginCms?WSDL','https://wswhomo.afip.gov.ar/wsfev1/service.asmx?WSDL'];
    }
    private function soap(string $url): \SoapClient {
        if (!class_exists('SoapClient')) throw new \RuntimeException('Falta la extensión PHP SOAP en el servidor.');
        return new \SoapClient($url, apply_filters('fusion_arca_soap_options', ['exceptions'=>true, 'trace'=>false, 'connection_timeout'=>15, 'cache_wsdl'=>WSDL_CACHE_MEMORY,
            'stream_context'=>$this->soap_context($url)], $url));
    }
    private function soap_context(string $url) {
        $ssl = ['verify_peer'=>true, 'verify_peer_name'=>true];
        if ($this->env === 'production' && $url === $this->endpoints()[1]) {
            // WSFE can prefer finite-field DH parameters rejected by modern OpenSSL.
            // Exclude DH without lowering SECLEVEL or disabling certificate checks.
            // This context covers both the WSDL download and subsequent SOAP calls.
            $ssl['ciphers'] = 'DEFAULT:!DH';
            $ssl['crypto_method'] = STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT
                | (defined('STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT') ? constant('STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT') : 0);
        }
        return stream_context_create(['http'=>['timeout'=>30], 'ssl'=>$ssl]);
    }
    public function credentials(): array {
        $suffix = $this->env === 'production' ? 'PROD' : 'HOMO';
        $certKey = 'FUSION_ARCA_CERT_'.$suffix; $privateKey = 'FUSION_ARCA_KEY_'.$suffix;
        if (!defined($certKey) || !defined($privateKey)) throw new \RuntimeException('Configurá el certificado y la clave privada de '.$this->env.' en wp-config.php. Ver la guía incluida.');
        $cert = realpath(constant($certKey)); $key = realpath(constant($privateKey));
        foreach ([$cert,$key] as $file) {
            if (!$file || !is_file($file) || !is_readable($file)) throw new \RuntimeException('El servidor no puede leer las credenciales configuradas.');
            foreach ([realpath(ABSPATH), realpath($_SERVER['DOCUMENT_ROOT'] ?? ABSPATH)] as $root) {
                if ($root && strpos($file, rtrim($root,DIRECTORY_SEPARATOR).DIRECTORY_SEPARATOR) === 0) throw new \RuntimeException('Guardá las credenciales fuera del directorio público de la web.');
            }
        }
        if (!function_exists('openssl_pkcs7_sign') || !function_exists('simplexml_load_string')) throw new \RuntimeException('Se requieren OpenSSL y SimpleXML en PHP.');
        $certificate = @openssl_x509_read(file_get_contents($cert));
        $passkey = 'FUSION_ARCA_PASSPHRASE_'.$suffix;
        $pass = defined($passkey) ? (string)constant($passkey) : '';
        $private = @openssl_pkey_get_private(file_get_contents($key), $pass);
        if (!$certificate || !$private || !openssl_x509_check_private_key($certificate,$private)) throw new \RuntimeException('El certificado y la clave privada no coinciden o no se pueden abrir.');
        $info = openssl_x509_parse($certificate);
        if (time() < ($info['validFrom_time_t'] ?? PHP_INT_MAX) || time() >= ($info['validTo_time_t'] ?? 0)) throw new \RuntimeException('El certificado no está vigente.');
        return [$certificate,$private,openssl_x509_fingerprint($certificate),$info['validTo_time_t']];
    }
    private function auth(string $service='wsfe'): array {
        if(!in_array($service,['wsfe','ws_sr_padron_a13'],true))throw new \InvalidArgumentException('Servicio ARCA no permitido.');
        list($cert,$key,$fingerprint) = $this->credentials();
        $cacheKey = 'fusion_arca_ta_'.md5($this->env.'|'.$this->cuit.'|'.$fingerprint.($service==='wsfe'?'':'|'.$service));
        $cached = get_transient($cacheKey);
        if (is_array($cached) && !empty($cached['Token']) && !empty($cached['Sign'])) return $cached + ['Cuit'=>(int)$this->cuit];
        global $wpdb;
        $lock = 'fbarca_auth_'.md5($cacheKey);
        if ((int)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, 10)', $lock)) !== 1) throw new \RuntimeException('Otra solicitud está autenticándose. Volvé a intentar.');
        try {
            $cached = get_transient($cacheKey);
            if (is_array($cached) && !empty($cached['Token'])) return $cached + ['Cuit'=>(int)$this->cuit];
            $xml = '<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>'.time().'</uniqueId><generationTime>'.gmdate('c',time()-300).'</generationTime><expirationTime>'.gmdate('c',time()+3600).'</expirationTime></header><service>'.$service.'</service></loginTicketRequest>';
            $in = tempnam(sys_get_temp_dir(),'fba'); $out = tempnam(sys_get_temp_dir(),'fbs');
            if (!$in || !$out) throw new \RuntimeException('No se pueden crear archivos temporales para la firma.');
            try {
                chmod($in,0600); chmod($out,0600); file_put_contents($in,$xml);
                if (!openssl_pkcs7_sign($in,$out,$cert,$key,[],0)) throw new \RuntimeException('No se pudo firmar la solicitud de acceso.');
                $parts = preg_split('/\r?\n\r?\n/',file_get_contents($out),2);
                $cms = preg_replace('/\s+/','',$parts[1] ?? '');
                if (!$cms) throw new \RuntimeException('Firma vacía.');
                $reply = $this->soap($this->endpoints()[0])->loginCms(['in0'=>$cms]);
                $old = libxml_use_internal_errors(true);
                $ta = simplexml_load_string($reply->loginCmsReturn ?? '', 'SimpleXMLElement', LIBXML_NONET);
                libxml_clear_errors(); libxml_use_internal_errors($old);
                if (!$ta || !(string)$ta->credentials->token || !(string)$ta->credentials->sign) throw new \RuntimeException('ARCA no devolvió un ticket de acceso válido.');
                $data = ['Token'=>(string)$ta->credentials->token, 'Sign'=>(string)$ta->credentials->sign];
                $ttl = max(1,min(36000,strtotime((string)$ta->header->expirationTime)-time()-120));
                set_transient($cacheKey,$data,$ttl);
                return $data + ['Cuit'=>(int)$this->cuit];
            } finally { if ($in) @unlink($in); if ($out) @unlink($out); }
        } finally { $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)',$lock)); }
    }
    public function call(string $method, array $args = []): array {
        $allowed = ['FEParamGetPtosVenta','FEParamGetCondicionIvaReceptor','FEParamGetCotizacion','FECompUltimoAutorizado','FECompConsultar','FECAESolicitar'];
        if (!in_array($method,$allowed,true)) throw new \InvalidArgumentException('Método ARCA no permitido.');
        try{$auth = $this->auth();}
        catch(\SoapFault $e){throw Diagnostics::failure($e,'Facturación: autenticación WSAA para wsfe',$this->env);}
        try{if (!$this->soap) $this->soap = $this->soap($this->endpoints()[1]);}
        catch(\SoapFault $e){throw Diagnostics::failure($e,'Facturación: carga del servicio WSFE',$this->env);}
        try{$response = $this->soap->$method(['Auth'=>$auth] + $args);}
        catch(\SoapFault $e){throw Diagnostics::failure($e,'Facturación: consulta '.$method,$this->env);}
        return json_decode(json_encode($response->{$method.'Result'} ?? []),true) ?: [];
    }
    public static function rows($value): array {
        if (!$value) return [];
        return isset($value[0]) ? $value : [$value];
    }
    public function padron(string $method,array $args): array {
        if(!in_array($method,['getPersona','getIdPersonaListByDocumento'],true))throw new \InvalidArgumentException('Consulta de padrón no permitida.');
        try{$auth=$this->auth('ws_sr_padron_a13');}
        catch(\Throwable $e){throw Diagnostics::failure($e,'Padrón: autenticación WSAA para ws_sr_padron_a13',$this->env);}
        try{if(!$this->padronSoap)$this->padronSoap=$this->soap(($this->env==='production'?'https://aws.afip.gov.ar':'https://awshomo.afip.gov.ar').'/sr-padron/webservices/personaServiceA13?WSDL');}
        catch(\Throwable $e){throw Diagnostics::failure($e,'Padrón: carga del servicio A13',$this->env);}
        try{$response=$this->padronSoap->$method(['token'=>$auth['Token'],'sign'=>$auth['Sign'],'cuitRepresentada'=>$auth['Cuit']]+$args);}
        catch(\Throwable $e){throw Diagnostics::failure($e,'Padrón: consulta '.$method,$this->env);}
        $key=$method==='getPersona'?'personaReturn':'idPersonaListReturn';
        return json_decode(json_encode($response->$key??[]),true)?:[];
    }
    public static function error(array $r): string {
        $out = [];
        foreach (self::rows($r['Errors']['Err'] ?? []) as $e) $out[] = ($e['Code'] ?? '').': '.($e['Msg'] ?? 'Error de ARCA');
        return implode(' | ',$out);
    }
    public function consult(int $point, int $type, int $number): ?array {
        $r = $this->call('FECompConsultar',['FeCompConsReq'=>['CbteTipo'=>$type,'CbteNro'=>$number,'PtoVta'=>$point]]);
        if (!empty($r['ResultGet'])) return $r['ResultGet'];
        $errs = self::rows($r['Errors']['Err'] ?? []);
        if (count($errs) === 1 && (int)($errs[0]['Code'] ?? 0) === 602) return null;
        throw new \RuntimeException(self::error($r) ?: 'ARCA no confirmó si el comprobante existe.');
    }
    public function rate(): float {
        $r = $this->call('FEParamGetCotizacion',['MonId'=>'DOL']);
        if (self::error($r)) throw new \RuntimeException(self::error($r));
        $rate = (float)($r['ResultGet']['MonCotiz'] ?? 0);
        if ($rate <= 0) throw new \RuntimeException('ARCA no devolvió una cotización USD válida.');
        return $rate;
    }
}
