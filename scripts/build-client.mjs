// Bundles the browser half into a single classic script (DSH loads client halves
// as plain scripts that call window.__ModuleLoader__.load).
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/client-entry.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  outfile: 'dist/client.js',
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('built dist/client.js');
