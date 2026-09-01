import { buildApp } from './app';

const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || '0.0.0.0';

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
