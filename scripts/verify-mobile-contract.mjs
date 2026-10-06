import fs from 'node:fs';
import crypto from 'node:crypto';
import YAML from 'yaml';

const file = new URL('../openapi/mobile-v1.yaml', import.meta.url);
const source = fs.readFileSync(file);
const spec = YAML.parse(source.toString('utf8'));
if (!spec?.openapi || !spec?.info?.version || !spec?.paths) throw new Error('mobile-v1.yaml no es un OpenAPI válido');
const sha256 = crypto.createHash('sha256').update(source).digest('hex');
if (process.env.MOBILE_OPENAPI_SHA256 && process.env.MOBILE_OPENAPI_SHA256 !== sha256) {
  throw new Error(`hash OpenAPI inesperado: ${sha256}`);
}
console.log(JSON.stringify({ file: file.pathname, version: spec.info.version, paths: Object.keys(spec.paths).length, sha256 }));
