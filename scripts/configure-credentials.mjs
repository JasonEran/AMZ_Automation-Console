#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  deleteDingTalkCredentials,
  deleteZiniaoCredentials,
  DINGTALK_KEYCHAIN_SERVICE,
  loadDingTalkCredentials,
  loadZiniaoCredentials,
  saveDingTalkCredentials,
  saveZiniaoCredentials,
  ZINIAO_KEYCHAIN_SERVICE,
} from '../src/lib/credentials.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const action = process.argv[2] || 'setup';
const kind = process.argv[3] || 'ziniao';

function normalizeDingTalkChannel(value) {
  return /^(?:ops|operations|运维)$/i.test(String(value || '')) ? 'operations' : 'regular';
}

function hiddenQuestion(label) {
  return new Promise((resolve, reject) => {
    let value = '';
    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          cleanup();
          reject(new Error('已取消'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
        } else if (ch >= ' ') {
          value += ch;
          stdout.write('•');
        }
      }
    };
    stdin.on('data', onData);
  });
}

if (action === 'migrate') {
  const script = path.join(SCRIPT_DIR, 'migrate-config-secrets.mjs');
  try {
    execFileSync(process.execPath, [script, ...process.argv.slice(3)], { stdio: 'inherit' });
    process.exit(0);
  } catch (error) {
    process.exit(Number(error.status) || 2);
  }
}

if (action === 'status') {
  if (kind === 'dingtalk' || kind === 'all') {
    for (const channel of ['regular', 'operations']) {
      const current = loadDingTalkCredentials({ channel });
      console.log(current.complete
        ? `✓ 钉钉 ${channel} 通道凭据可用，来源: ${current.source}（值未显示）`
        : `- 钉钉 ${channel} 通道未配置`);
    }
  }
  if (kind === 'ziniao' || kind === 'all') {
    const current = loadZiniaoCredentials();
    console.log(current.complete
      ? `✓ 紫鸟凭据可用，来源: ${current.source}（值未显示）`
      : '✗ 紫鸟凭据不可用。执行 npm run credentials:setup');
    if (kind === 'ziniao') process.exit(current.complete ? 0 : 1);
  }
  process.exit(0);
}

if (action === 'delete') {
  if (kind === 'dingtalk') {
    const channel = normalizeDingTalkChannel(process.argv[4]);
    console.log(deleteDingTalkCredentials({ channel })
      ? `✓ 已删除钉钉 ${channel} 通道的 Keychain 凭据`
      : '- 没有可删除的钉钉通道凭据');
  } else {
    console.log(deleteZiniaoCredentials() ? '✓ 已从 macOS Keychain 删除紫鸟凭据' : '- 没有可删除的紫鸟凭据');
  }
  process.exit(0);
}

if (action !== 'setup') {
  console.error('用法: configure-credentials.mjs setup|status|delete|migrate [ziniao|dingtalk|all] [regular|operations]');
  process.exit(2);
}
if (process.platform !== 'darwin') {
  console.error('此向导使用 macOS Keychain。其他系统请使用 root:root 0600 EnvironmentFile。');
  process.exit(2);
}
if (!stdin.isTTY) {
  console.error('凭据向导必须在交互式终端运行。');
  process.exit(2);
}

try {
  if (kind === 'dingtalk') {
    const channel = normalizeDingTalkChannel(process.argv[4]);
    const webhook = (await hiddenQuestion(`钉钉 ${channel} Webhook（输入隐藏）: `)).trim();
    const secret = (await hiddenQuestion(`钉钉 ${channel} 加签 Secret（输入隐藏，可留空）: `)).trim();
    let parsed;
    try { parsed = new URL(webhook); } catch { throw new Error('Webhook 必须是合法 HTTPS URL'); }
    if (parsed.protocol !== 'https:') throw new Error('Webhook 必须是合法 HTTPS URL');
    saveDingTalkCredentials({ webhook, secret }, { channel });
    console.log(`✓ 已安全保存钉钉 ${channel} 通道到 macOS 登录钥匙串 (${DINGTALK_KEYCHAIN_SERVICE})`);
  } else {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const company = (await rl.question('紫鸟企业名: ')).trim();
    const username = (await rl.question('自动化成员用户名: ')).trim();
    rl.close();
    const password = await hiddenQuestion('自动化成员密码（输入隐藏）: ');
    saveZiniaoCredentials({ company, username, password });
    console.log(`✓ 已安全保存到 macOS 登录钥匙串 (${ZINIAO_KEYCHAIN_SERVICE})`);
  }
  console.log('  定时任务会自动读取，凭据不会写入项目、plist 或日志。');
} catch (error) {
  console.error(`保存失败: ${String(error.message || error).replace(/[\r\n]+/g, ' ')}`);
  process.exit(2);
}
