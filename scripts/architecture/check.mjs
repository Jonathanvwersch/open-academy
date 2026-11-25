import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';
import { ResolverFactory } from 'oxc-resolver';
import {
  aesopBuiltins,
  aesopDependencies,
  browserForbiddenPackages,
  cliDependencies,
  deploymentImports,
  publicFeatureModules,
  sharedPackageDependencies,
  sourceEntries,
  sourceLayers,
} from './policy.mjs';

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const skipped = new Set(['node_modules', 'dist', '.git', '.tanstack', '.vite', '__pycache__']);
const codePattern = /\.(?:[cm]?js|tsx?)$/;
const testPattern = /(?:\.test\.|\.spec\.|\/tests\/|^tests\/)/;

function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? (skipped.has(entry.name) ? [] : files(name)) : [name];
  });
}

function walk(node, callback) {
  if (!node || typeof node !== 'object') return;
  callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value))
      value.forEach((child) => {
        walk(child, callback);
      });
    else if (value && typeof value === 'object') walk(value, callback);
  }
}

function importRequests(program) {
  const requests = [];
  walk(program, (node) => {
    if (
      ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) &&
      node.source
    ) {
      requests.push(node.source.value);
    }
    if (node.type === 'ImportExpression' && node.source.type === 'Literal')
      requests.push(node.source.value);
    if (node.type === 'TSImportType') {
      const value = node.source?.value ?? node.argument?.value ?? node.argument?.literal?.value;
      if (typeof value === 'string') requests.push(value);
    }
    if (
      node.type === 'CallExpression' &&
      ['require', 'require.resolve'].includes(
        node.callee.name ??
          (node.callee.object?.name === 'require' ? `require.${node.callee.property?.name}` : ''),
      ) &&
      node.arguments[0]?.type === 'Literal'
    )
      requests.push(node.arguments[0].value);
  });
  return [...new Set(requests)];
}

function owner(file) {
  return file.match(/^(?:apps|packages)\/[^/]+/)?.[0] ?? '.';
}

function feature(file) {
  return file.match(/^apps\/(web|api)\/src\/features\/([^/]+)\//)?.slice(1);
}

function packageName(request) {
  return request.startsWith('@') ? request.split('/').slice(0, 2).join('/') : request.split('/')[0];
}

function packageExport(exports, key) {
  if (exports?.[key]) return exports[key];
  const patterns = Object.entries(exports ?? {})
    .filter(([pattern]) => pattern.includes('*'))
    .sort(([left], [right]) => right.replace('*', '').length - left.replace('*', '').length);
  for (const [pattern, value] of patterns) {
    const [prefix, suffix] = pattern.split('*');
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    const end = suffix ? key.length - suffix.length : key.length;
    const match = key.slice(prefix.length, end);
    if (typeof value === 'string') return value.replaceAll('*', match);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([condition, target]) => [
          condition,
          typeof target === 'string' ? target.replaceAll('*', match) : target,
        ]),
      );
  }
  return undefined;
}

export function checkArchitecture(root = fileURLToPath(new URL('../../', import.meta.url))) {
  root = realpathSync(root);
  const errors = [];
  const graph = new Map();
  const manifests = new Map();
  for (const dir of [
    '.',
    ...['apps', 'packages'].flatMap((folder) =>
      existsSync(path.join(root, folder))
        ? readdirSync(path.join(root, folder), { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => `${folder}/${e.name}`)
        : [],
    ),
  ]) {
    const file = path.join(root, dir, 'package.json');
    if (existsSync(file)) manifests.set(dir, JSON.parse(readFileSync(file, 'utf8')));
    else errors.push(`${dir}: workspace packages must have a package.json`);
  }
  const byName = new Map(
    [...manifests].map(([dir, manifest]) => [manifest.name, { dir, manifest }]),
  );
  const resolvers = new Map();
  const report = (file, message) => errors.push(`${file}: ${message}`);
  const allFiles = ['apps', 'packages', 'scripts', 'api', 'tests', 'labs'].flatMap((folder) =>
    files(path.join(root, folder)),
  );
  if (existsSync(path.join(root, 'src')))
    report('src', 'put application code in apps/web or apps/api, and shared code in packages');
  for (const absolute of allFiles.filter((f) => codePattern.test(f))) {
    const file = path.relative(root, absolute).split(path.sep).join('/');
    const own = owner(file);
    const isTest = testPattern.test(file);
    const generated = file === 'apps/web/src/routeTree.gen.ts';
    const source = readFileSync(absolute, 'utf8');
    const parts = file.split('/');
    if (['apps', 'packages', 'scripts'].includes(parts[0])) {
      for (const [i, part] of parts.entries()) {
        if (i === parts.length - 1 && (generated || part === '__root.tsx')) continue;
        const name =
          i === parts.length - 1
            ? part
                .replace(/\.(?:[cm]?js|tsx?)$/, '')
                .replace(/\.d$/, '')
                .replace(/\.(?:test|spec)$/, '')
            : part;
        const route = file.startsWith('apps/web/src/routes/');
        const normalized = route ? name.replace(/\$[a-zA-Z][a-zA-Z0-9]*/g, 'param') : name;
        if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(normalized))
          report(file, `use kebab-case for ${part}`);
      }
    }
    const appSource = file.match(/^apps\/(web|api)\/src\/(.+)$/);
    if (appSource) {
      const [, app, local] = appSource;
      if (local.includes('/')) {
        if (!sourceLayers[app].has(local.split('/')[0]))
          report(
            file,
            `choose an existing ${app} source layer or update the architecture policy deliberately`,
          );
      } else if (!sourceEntries[app].has(local))
        report(
          file,
          'put behavior in its owning feature; reserve the source root for application entry points',
        );
    }
    if (generated) continue;
    const parsed = parseSync(file, source);
    if (parsed.errors.length) {
      report(file, 'cannot parse source to validate its dependencies');
      continue;
    }
    for (const comment of parsed.comments) {
      const value = comment.value.trim();
      if (
        /^biome-ignore(?:-all)?\b/.test(value) &&
        !/^biome-ignore(?:-all)?\s+[^:]+:\s*\S/.test(value)
      )
        report(file, 'a Biome suppression must include a reason after a colon');
    }
    const dependencies = new Set(
      Object.keys({ ...manifests.get(own)?.dependencies, ...manifests.get(own)?.devDependencies }),
    );
    const targets = [];
    for (let request of importRequests(parsed.program)) {
      if (builtins.has(request)) {
        const aesopBuiltin = own === 'packages/aesop' && aesopBuiltins.has(request);
        if (
          !isTest &&
          !file.startsWith('packages/cli/src/') &&
          !aesopBuiltin &&
          (own.startsWith('packages/') || (own === 'apps/web' && !file.endsWith('config.ts')))
        )
          report(file, `browser-safe code cannot import ${request}`);
        continue;
      }
      request = request.replace(/\?(?:url|raw)$/, '');
      let target;
      if (file === 'api/index.ts' && request === '../apps/api/dist-vercel/server.mjs') {
        target = 'apps/api/dist-vercel/server.mjs';
      } else if (request.startsWith('.') || request.startsWith('@/')) {
        if (!resolvers.has(own))
          resolvers.set(
            own,
            new ResolverFactory({
              extensions: ['.ts', '.tsx', '.mjs', '.js', '.json', '.css'],
              extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
              alias: { '@': [path.join(root, 'apps/web/src')] },
              symlinks: true,
            }),
          );
        const resolution = resolvers.get(own).sync(path.dirname(absolute), request);
        if (!resolution.path) {
          report(file, `cannot resolve ${request}`);
          continue;
        }
        target = path.relative(root, resolution.path).split(path.sep).join('/');
        if (owner(target) !== own && own !== '.')
          report(file, `use an explicit workspace package export instead of ${request}`);
      } else {
        const dependency = packageName(request);
        if (!dependencies.has(dependency) && dependency !== manifests.get(own)?.name)
          report(file, `declare ${dependency} in ${own}/package.json`);
        const workspace = byName.get(dependency);
        if (workspace) {
          if (own === 'apps/web' && browserForbiddenPackages.has(dependency))
            report(
              file,
              'apps/web cannot import @academy/aesop because it uses Node filesystem APIs',
            );
          if (
            workspace.dir.startsWith('apps/') &&
            !(own === 'packages/cli' && request === '@academy/api/content')
          )
            report(
              file,
              'applications cannot be imported as libraries; extract a shared contract or helper',
            );
          const key = request === dependency ? '.' : `.${request.slice(dependency.length)}`;
          const exported = packageExport(workspace.manifest.exports, key);
          const value =
            typeof exported === 'string' ? exported : (exported?.import ?? exported?.default);
          if (!value) {
            report(file, `${request} is private; use one of the package's explicit exports`);
            continue;
          }
          target = path.posix.normalize(`${workspace.dir}/${value}`);
          if (!existsSync(path.join(root, target)))
            report(file, `${request} exports a missing file`);
        }
        const nodeCliDependency = own === 'packages/cli' && cliDependencies.has(dependency);
        const packageDependencyAllowed =
          own === 'packages/aesop'
            ? aesopDependencies.has(dependency)
            : sharedPackageDependencies.has(dependency);
        if (
          !isTest &&
          own.startsWith('packages/') &&
          !packageDependencyAllowed &&
          !nodeCliDependency
        )
          report(file, `${dependency} does not belong in a browser-safe shared package`);
        if (
          !isTest &&
          file.startsWith('apps/api/src/features/') &&
          file.endsWith('service.ts') &&
          dependency === 'hono'
        )
          report(file, 'keep Hono in routes; services accept plain inputs');
      }
      if (!target) continue;
      targets.push(target);
      if (own === 'apps/web' && target.startsWith('apps/api/'))
        report(
          file,
          'web cannot import API source, even types; move the public shape to packages/contracts',
        );
      if (
        own.startsWith('packages/') &&
        target.startsWith('apps/') &&
        !(own === 'packages/cli' && target === 'apps/api/src/content/public.ts')
      )
        report(file, 'shared packages cannot depend on applications');
      if (file.startsWith('api/') && (file !== 'api/index.ts' || !deploymentImports.has(target)))
        report(file, 'the root api directory is only the thin Vercel adapter');
      if (file.startsWith('apps/web/src/')) {
        const from = file.slice('apps/web/src/'.length).split('/')[0];
        const to = target.startsWith('apps/web/src/')
          ? target.slice('apps/web/src/'.length).split('/')[0]
          : null;
        if (
          ['components', 'api', 'lib', 'hooks'].includes(from) &&
          ['features', 'routes', 'app'].includes(to)
        )
          report(file, 'shared frontend code cannot import features, routes, or app composition');
        if (from === 'features' && ['routes', 'app'].includes(to))
          report(
            file,
            'features cannot import routes or application composition; use getRouteApi for route hooks',
          );
      }
      const fromFeature = feature(file),
        toFeature = feature(target);
      if (
        fromFeature &&
        toFeature &&
        fromFeature[0] === toFeature[0] &&
        fromFeature[1] !== toFeature[1]
      ) {
        const local = target.replace(/^apps\/(web|api)\/src\//, '');
        const queryEntry =
          fromFeature[0] === 'web' && /^features\/[^/]+\/(queries|mutations)\.ts$/.test(local);
        if (!queryEntry && !publicFeatureModules[fromFeature[0]].has(local))
          report(
            file,
            `${local} is private to ${toFeature[1]}; expose a narrow public module or compose outside the features`,
          );
      }
    }
    graph.set(
      file,
      targets.filter((target) => codePattern.test(target)),
    );
  }
  const visited = new Set(),
    active = new Set(),
    stack = [];
  function visit(file) {
    if (active.has(file)) {
      report(file, `dependency cycle: ${[...stack.slice(stack.indexOf(file)), file].join(' -> ')}`);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    active.add(file);
    stack.push(file);
    for (const target of graph.get(file) ?? []) visit(target);
    stack.pop();
    active.delete(file);
  }
  for (const file of graph.keys()) visit(file);
  return [...new Set(errors)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkArchitecture();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Architecture checks passed.');
}
