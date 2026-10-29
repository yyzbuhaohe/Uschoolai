/* keyvault.js —— API Key 的本地加密
 *
 * 为什么要有它：API Key 存明文在 control.json 里，任何人打开文件、投屏、截图都会看到。
 * 这里用 AES-256-GCM 加密后再落盘，密钥由「本机 MachineGuid + 项目固定盐」派生 ——
 * 换台电脑解得开才怪，换机器请重新填一次。
 *
 * 作为模块：
 *   const kv = require('./keyvault');
 *   kv.encrypt('sk-xxx')  → 'v1:base64...'
 *   kv.decrypt('v1:...')  → 'sk-xxx'
 *
 * 作为命令行（serve.py 存 key 时调）：
 *   echo sk-xxx | node keyvault.js enc      # 输出密文
 *   echo v1:...  | node keyvault.js dec     # 输出明文
 */
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const os = require('os');

const SALT = 'unipus-potato-keyvault-v1';

let cachedMachine = null;
function machineId() {
  if (cachedMachine) return cachedMachine;
  let guid = '';
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    }).toString();
    const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
    if (m) guid = m[1];
  } catch (e) { /* 非 Windows 或没权限 */ }
  if (!guid) guid = 'host:' + os.hostname();
  cachedMachine = crypto.createHash('sha256').update(SALT + '|' + guid).digest();
  return cachedMachine;
}

function encrypt(plain) {
  const text = String(plain || '');
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', machineId(), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, body]).toString('base64');
}

function decrypt(blob) {
  const s = String(blob || '');
  if (!s.startsWith('v1:')) return '';
  const raw = Buffer.from(s.slice(3), 'base64');
  if (raw.length < 29) return '';
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', machineId(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch (e) {
    return '';   // 换了机器 / 密文被改过
  }
}

function looksEncrypted(s) {
  return typeof s === 'string' && s.startsWith('v1:');
}

module.exports = { encrypt, decrypt, looksEncrypted };

if (require.main === module) {
  const mode = process.argv[2] || 'enc';
  let input = '';
  try { input = require('fs').readFileSync(0, 'utf8'); } catch (e) { input = ''; }
  input = input.replace(/\r?\n$/, '');
  if (mode === 'enc') {
    if (!input) { console.error('空输入'); process.exit(1); }
    process.stdout.write(encrypt(input));
  } else if (mode === 'dec') {
    const out = decrypt(input);
    if (!out) { console.error('解不开（换机器了？或者密文不对）'); process.exit(2); }
    process.stdout.write(out);
  } else {
    console.error('用法：node keyvault.js enc|dec  （从 stdin 读）');
    process.exit(1);
  }
}
