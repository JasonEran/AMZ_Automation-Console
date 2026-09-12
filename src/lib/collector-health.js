export function isTransientZiniaoStartupFailure(result = {}) {
  if (Number(result.status) === 0) return false;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return /WebDriver HTTP (?:服务未启动|service (?:is )?not (?:running|started|available))/i.test(output);
}

export async function runDoctorWithStartupGrace({
  runDoctor,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  graceMs = 90000,
  intervalMs = 2000,
} = {}) {
  if (typeof runDoctor !== 'function') throw new TypeError('runDoctor is required');
  const boundedGraceMs = Math.max(0, Math.min(5 * 60 * 1000, Number(graceMs) || 0));
  const boundedIntervalMs = Math.max(250, Math.min(10000, Number(intervalMs) || 2000));
  const deadline = now() + boundedGraceMs;
  let result = runDoctor();
  while (isTransientZiniaoStartupFailure(result) && now() < deadline) {
    await sleep(boundedIntervalMs);
    result = runDoctor();
  }
  return result;
}
