import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import helmet from 'helmet';
import { resolve } from 'node:path';
import { Accounts } from './accounts.js';
import { Agent } from './agent.js';
import { Api } from './api.js';
import { CONFIG, Config, readConfig } from './config.js';
import { Database } from './db.js';
import { Gmail } from './gmail.js';
import { GmailResults } from './gmail-results.js';
import { Finance } from './finance.js';
import { GoogleSignin } from './google-signin.js';
import { History } from './history.js';
import { Worker } from './worker.js';

@Module({})
class App {}

export async function createApp(config: Config, startWorker = true) {
  const app = await NestFactory.create<NestExpressApplication>({
    module: App,
    controllers: [Api],
    providers: [
      { provide: CONFIG, useValue: config }, Database, Accounts, Agent, Gmail, GmailResults, History, Finance, GoogleSignin,
      ...(startWorker ? [Worker] : []),
    ],
  }, { bodyParser: false, logger: ['error', 'warn'] });
  if (config.secure) app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: { upgradeInsecureRequests: config.secure ? [] : null },
    },
    strictTransportSecurity: config.secure,
  }));
  app.use('/v1', (req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.path.startsWith('/internal/') &&
        req.get('Origin') !== config.origin) {
      res.status(403).json({ message: 'Origen inválido.' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '1550kb' }));
  const server: express.Express = app.getHttpAdapter().getInstance();
  server.get('/.well-known/assetlinks.json', (_req, res) => {
    if (!config.ANDROID_APP_LINK_SHA256) return res.sendStatus(404);
    return res.json([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app', package_name: 'co.com.styleplus.mailgasto',
        sha256_cert_fingerprints: [config.ANDROID_APP_LINK_SHA256.toUpperCase()],
      },
    }]);
  });
  server.get(['/mobile/gmail/return', '/mobile/auth/google/return'], (_req, res) => {
    return res.set('Referrer-Policy', 'no-referrer').type('text').send(
      'Abre MailGasto IA en tu dispositivo Android y comprueba que los enlaces compatibles estén habilitados.',
    );
  });
  server.get(['/mobile/auth/reset', '/mobile/auth/delete'], (_req, res) => {
    res.set('Referrer-Policy', 'no-referrer').set('Cache-Control', 'no-store').sendFile(resolve('public/index.html'));
  });
  app.useStaticAssets(resolve('public'), { maxAge: 0, index: 'index.html' });
  await app.get(Database).migrate();
  return app;
}

if (require.main === module) {
  const config = readConfig();
  createApp(config).then(async app => {
    app.enableShutdownHooks();
    await app.listen(config.PORT, '0.0.0.0');
    console.info('MailGasto API ready on port ' + config.PORT);
  }).catch(error => {
    console.error('Could not start MailGasto API', error);
    process.exit(1);
  });
}
