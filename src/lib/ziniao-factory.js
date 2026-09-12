import { Ziniao } from './ziniao.js';
import { ZiniaoWebDriver } from './ziniao-webdriver.js';

export function createZiniao({ config, logger }) {
  const mode = String(config?.ziniao?.mode || 'webdriver').toLowerCase();
  if (mode === 'webdriver') {
    return new ZiniaoWebDriver({ config: config.ziniao.webdriver || {}, logger });
  }
  if (mode === 'cli' || mode === 'zclaw') {
    return new Ziniao({ bin: config.ziniao.bin, logger });
  }
  throw new Error(`未知紫鸟传输模式: ${mode}（可选 webdriver / cli）`);
}
