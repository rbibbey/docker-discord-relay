#!/usr/bin/env node
// Cross-platform Docker helper: build, tag, push
// Works on Windows (PowerShell/CMD) and macOS/Linux (zsh/bash)

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
// Load environment from project .env (works regardless of cwd)
dotenv.config({ path: path.join(repoRoot, '.env') });

function resolveImage() {
  return process.env.DOCKER_IMAGE || 'cbmediallc/docker-discord-relay';
}

function readPackageVersion() {
  const pkgPath = path.join(repoRoot, 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  return pkg.version || 'latest';
}

function getArgValue(argv, keys) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // --key=value
    if (a.startsWith('--')) {
      const [k, v] = a.split('=');
      if (keys.includes(k.replace(/^--/, ''))) return v ?? argv[i + 1];
    }
    // -k value
    if (a.startsWith('-') && !a.startsWith('--')) {
      const k = a.replace(/^-+/, '');
      if (keys.includes(k)) return argv[i + 1];
    }
  }
  return undefined;
}

function resolveTag({ requireTagFor } = {}) {
  const version = readPackageVersion();
  const envTag = process.env.TAG || process.env.tag || process.env.npm_config_tag;
  const cliTag = getArgValue(process.argv.slice(2), ['tag', 't']);
  const tag = cliTag || envTag || version;
  if (requireTagFor && !tag) {
    console.error(`Missing tag. Provide with --tag <name> or set TAG env var. Example: TAG=latest node scripts/docker.mjs ${requireTagFor}`);
    process.exit(1);
  }
  return tag;
}

function resolveFromTag() {
  const version = readPackageVersion();
  const envFrom = process.env.FROM_TAG || process.env.from || process.env.npm_config_from;
  const cliFrom = getArgValue(process.argv.slice(2), ['from']);
  return cliFrom || envFrom || version;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: false, ...opts });
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  const [cmd] = process.argv.slice(2).filter((a) => !a.startsWith('-'));

  if (!cmd || ['help', '-h', '--help'].includes(cmd)) {
    console.log(`Usage:
  node scripts/docker.mjs <command> [--tag <name>] [--from <name>] [--registry <host>] [--latest]

Commands:
  build   Build and tag image (defaults tag to package version)
  tag     Retag an existing local image (defaults --from to package version)
  push    Push image to registry (defaults tag to package version)
  publish Build (with tag), optionally tag latest, and push tag(s)
  login   Log into Docker registry (defaults to Docker Hub)

Options:
  --tag, -t   Tag to use (or set TAG env var)
  --from      Source tag for retagging (or set FROM_TAG env var)
  --registry  Registry hostname for login (or set DOCKER_REGISTRY)
  --latest    When used with publish: also tag and push :latest

Examples:
  node scripts/docker.mjs build --tag 1.0.0
  node scripts/docker.mjs tag --from 1.0.0 --tag latest
  node scripts/docker.mjs push --tag 1.0.0
  node scripts/docker.mjs login --registry index.docker.io
`);
    process.exit(0);
  }

  if (cmd === 'build') {
    const IMAGE = resolveImage();
    const tag = resolveTag();
    await run('docker', ['build', '-t', `${IMAGE}:${tag}`, repoRoot]);
    return;
  }

  if (cmd === 'tag') {
    const IMAGE = resolveImage();
    const tag = resolveTag({ requireTagFor: 'tag' });
    const from = resolveFromTag();
    await run('docker', ['tag', `${IMAGE}:${from}`, `${IMAGE}:${tag}`]);
    return;
  }

  if (cmd === 'push') {
    const IMAGE = resolveImage();
    const tag = resolveTag();
    await run('docker', ['push', `${IMAGE}:${tag}`]);
    return;
  }

  if (cmd === 'login') {
    const registry = getArgValue(process.argv.slice(2), ['registry']) || process.env.DOCKER_REGISTRY;
    if (registry) {
      await run('docker', ['login', registry]);
    } else {
      await run('docker', ['login']);
    }
    return;
  }

  if (cmd === 'publish') {
    const IMAGE = resolveImage();
    const tag = resolveTag();
    const alsoLatest = process.argv.includes('--latest');
    // Build
    await run('docker', ['build', '-t', `${IMAGE}:${tag}`, repoRoot]);
    // Optionally tag latest
    if (alsoLatest) {
      await run('docker', ['tag', `${IMAGE}:${tag}`, `${IMAGE}:latest`]);
    }
    // Push main tag
    await run('docker', ['push', `${IMAGE}:${tag}`]);
    // Push latest if requested
    if (alsoLatest) {
      await run('docker', ['push', `${IMAGE}:latest`]);
    }
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
