import { buildApp } from './src/app.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

const app = buildApp({
  logLevel: process.env.LOG_LEVEL || 'info',
  storeMax: Number(process.env.STORE_MAX || 1000),
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(() => process.exit(0));
  });
}

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
