<?php
/** VPS credentials and constrained SOAP transport; never install on the shop. */
if (!defined('ABSPATH')) exit;
define('FUSION_ARCA_CERT_PROD','/opt/fusion-arca-private/produccion.crt');
define('FUSION_ARCA_KEY_PROD','/opt/fusion-arca-private/produccion.key');
add_filter('fusion_arca_soap_options',static function($options,$url){
    $parts=parse_url($url);
    if (($parts['scheme']??'')!=='https' || !in_array($parts['host']??'', ['wsaa.afip.gov.ar','servicios1.afip.gov.ar','aws.afip.gov.ar'],true)) {
        throw new RuntimeException('El VPS sólo tiene habilitados los servicios ARCA de producción.');
    }
    $proxy=json_decode(file_get_contents('/opt/fusion-arca-private/proxy.json'),true,512,JSON_THROW_ON_ERROR);
    return $options+['proxy_host'=>$proxy['host'],'proxy_port'=>8215,'proxy_login'=>'arca','proxy_password'=>$proxy['password']];
},10,2);
