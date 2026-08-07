#!/usr/bin/env node

/**
 * Copy the client Vite manifest next to the SSR bundle.
 *
 * The server bundle reads it at request time to emit the correct hashed asset
 * tags. It must live inside `server.dir` because that is the only directory
 * `lesser client install` uploads alongside the handler.
 *
 * Pattern taken from simulacrum's `scripts/copy-facetheory-manifest.mjs`.
 */

import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const clientManifestPath = path.resolve('build/client/.vite/manifest.json');
const serverDir = path.resolve('build/server');
const serverManifestPath = path.join(serverDir, 'client-manifest.json');

await mkdir(serverDir, { recursive: true });
await copyFile(clientManifestPath, serverManifestPath);

console.log('manifest: copied client manifest to build/server/client-manifest.json');
