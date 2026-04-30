const DEFAULT_TIMEOUT_MS = 1200;

function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown readiness error';
}

async function runCheck(name, check, timeoutMs) {
  const startedAt = Date.now();
  let timeoutId;

  try {
    await Promise.race([
      Promise.resolve().then(check),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);

    return {
      name,
      ok: true,
      latency_ms: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      latency_ms: Date.now() - startedAt,
      error: toErrorMessage(error),
    };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function createReadinessHandler({
  service,
  checks,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return async (_req, res) => {
    const startedAt = Date.now();
    const results = await Promise.all(
      Object.entries(checks).map(([name, check]) => runCheck(name, check, timeoutMs))
    );
    const ready = results.every((result) => result.ok);
    const dependencies = Object.fromEntries(
      results.map(({ name, ...result }) => [name, result])
    );

    res
      .status(ready ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json({
        success: ready,
        status: ready ? 'ready' : 'degraded',
        service,
        pid: process.pid,
        uptime_seconds: Math.round(process.uptime()),
        duration_ms: Date.now() - startedAt,
        dependencies,
      });
  };
}
