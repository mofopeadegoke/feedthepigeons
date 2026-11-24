import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';

type Handler = (request: Request) => Promise<Response> | Response;

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = req.method ?? 'GET';
  return new Request(new URL(req.url ?? '/', origin), {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  });
}

async function send(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * Runs the Vercel functions in /api inside `pnpm dev`, so the counter works locally without
 * the Vercel CLI or a Vercel login. Production never sees this: Vercel serves /api itself.
 */
function devApi(env: Record<string, string>): Plugin {
  return {
    name: 'dev-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      // The functions read process.env, as they do on Vercel; Vite only exposes VITE_* to the page.
      for (const [k, v] of Object.entries(env)) if (!(k in process.env)) process.env[k] = v;

      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        const match = /^\/api\/([a-z0-9-]+)$/i.exec(path);
        if (!match) return next();
        if (!existsSync(resolve(server.config.root, 'api', `${match[1]}.ts`))) {
          res.statusCode = 404;
          res.end();
          return;
        }
        try {
          // Loaded through Vite on every request so edits to /api apply without a restart.
          const mod = (await server.ssrLoadModule(`/api/${match[1]}.ts`)) as Record<string, unknown>;
          const method = (req.method ?? 'GET').toUpperCase();
          const handler = mod[method] as Handler | undefined;
          if (typeof handler !== 'function') {
            const allow = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter((m) => typeof mod[m] === 'function');
            res.statusCode = 405;
            res.setHeader('allow', allow.join(', '));
            res.end();
            return;
          }
          await send(res, await handler(await toRequest(req, 'http://localhost')));
        } catch (err) {
          server.config.logger.error(`[dev-api] ${path}: ${(err as Error).message}`);
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'dev api failed' }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  server: { host: true },
  plugins: [devApi(loadEnv(mode, process.cwd(), ''))],
  // three.js is one ~150 kB gzipped chunk by design; splitting it further only adds round trips.
  build: { chunkSizeWarningLimit: 700 },
}));
