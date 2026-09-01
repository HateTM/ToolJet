import { buildApp } from './app';
import { resolveListenConfig } from './listen-config';

const { host: HOST, port: PORT } = resolveListenConfig(process.env);

const app = buildApp();

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    app.log.info(`generation-engine listening on ${HOST}:${PORT}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.close().then(
      () => process.exit(0),
      (err) => {
        app.log.error(err);
        process.exit(1);
      }
    );
  });
}
