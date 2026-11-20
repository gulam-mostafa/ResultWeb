/**
 * Temporary guard: reports identifiers that are referenced somewhere in `src`
 * but are never bound in that module (and are not known globals).
 *
 * Catches the class of bug Vite cannot: `sectionRegistry is not defined`.
 */
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const traverse = _traverse.default ?? _traverse;

const GLOBALS = new Set([
  'window', 'document', 'navigator', 'console', 'localStorage', 'sessionStorage',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'Promise', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'Date', 'JSON',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'RegExp', 'Error', 'TypeError',
  'Intl', 'undefined', 'NaN', 'Infinity', 'globalThis', 'fetch', 'URL', 'URLSearchParams',
  'FormData', 'Blob', 'File', 'FileReader', 'crypto', 'performance', 'structuredClone',
  'HTMLElement', 'Node', 'Event', 'CustomEvent', 'alert', 'confirm', 'print', 'location',
  'history', 'process', 'module', 'require', 'exports', 'AbortController', 'TextEncoder',
  'TextDecoder', 'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'Image',
  'Audio', 'CustomEvent', 'queueMicrotask', 'btoa', 'atob', 'arguments', 'navigator',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'BigInt', 'Reflect', 'Proxy',
  'RangeError', 'SyntaxError', 'ReferenceError', 'WeakRef', 'FinalizationRegistry',
]);

const ROOT = path.resolve('src');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (/\.(jsx?|mjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const problems = [];
for (const file of await walk(ROOT)) {
  const code = await readFile(file, 'utf8');
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx'], errorRecovery: true });

  traverse(ast, {
    Program(programPath) {
      programPath.scope.crawl();
      programPath.traverse({
        Identifier(nodePath) {
          if (!nodePath.isReferencedIdentifier()) return;
          const name = nodePath.node.name;
          if (GLOBALS.has(name) || nodePath.scope.hasBinding(name, true)) return;
          const line = nodePath.node.loc?.start.line ?? 0;
          problems.push(`${path.relative(process.cwd(), file)}:${line} → ${name}`);
        },
      });
    },
  });
}

if (problems.length) {
  console.error(`Unbound identifiers found (${problems.length}):`);
  problems.forEach((entry) => console.error(`  ${entry}`));
  process.exit(1);
}
console.log('No unbound identifiers found in src/.');
