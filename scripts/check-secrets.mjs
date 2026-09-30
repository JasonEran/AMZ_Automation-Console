import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const binary = process.env.GITLEAKS_BIN || 'gitleaks';
const shared = ['--config', path.join(root, '.github/gitleaks.toml'),
  '--redact=100', '--no-banner', '--ignore-gitleaks-allow'];

function run(args) {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) {
    console.error('无法运行 Gitleaks。请安装文档指定版本，或设置 GITLEAKS_BIN；扫描未完成。');
    process.exit(2);
  }
  return result;
}

if (process.argv.includes('--self-test')) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-secret-check-'));
  fs.chmodSync(temp, 0o700);
  try {
    const samples = path.join(temp, 'samples');
    fs.mkdirSync(samples, { mode: 0o700 });
    fs.writeFileSync(path.join(samples, 'example.env'), 'DINGTALK_WEBHOOK=\nDINGTALK_SECRET=\n', { mode: 0o600 });
    fs.writeFileSync(path.join(samples, 'historical-mock.txt'),
      'https://oapi.dingtalk.com/robot/send?access_token=' + 'BUSINESS_FIXTURE\n', { mode: 0o600 });
    if (run(['dir', samples, ...shared]).status !== 0) throw new Error('空值模板被误报或扫描失败');
    // Deliberately synthetic values are generated only in a private temp dir.
    const fakeToken = randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(samples, 'synthetic.env'),
      'DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=' + fakeToken
      + '\nDINGTALK_SECRET=' + 'SEC' + fakeToken + '\n', { mode: 0o600 });
    const report = path.join(temp, 'redacted.json');
    const result = run(['dir', samples, ...shared, '--report-format=json', '--report-path', report]);
    if (result.status !== 1) throw new Error('模拟凭据未被阻断或扫描执行异常');
    const text = fs.readFileSync(report, 'utf8');
    const rules = new Set(JSON.parse(text).map(item => item.RuleID));
    for (const id of ['amzguard-dingtalk-webhook-token', 'amzguard-dingtalk-signing-secret']) {
      if (!rules.has(id)) throw new Error(`规则未命中：${id}`);
    }
    if ([text, result.stdout, result.stderr].some(value => value.includes(fakeToken))) {
      throw new Error('扫描输出未完整遮蔽模拟凭据');
    }
    console.log('密钥扫描自检通过：空模板放行、模拟凭据阻断、输出完全脱敏。');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
} else {
  const result = run(['git', root, '--log-opts=--all --full-history', ...shared]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 2;
}
