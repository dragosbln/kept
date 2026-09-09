// esbuild wrapper: bundles src/embed.ts into the single-file script-tag
// artifact (dist/kept-widget.js). Separate from the tsc build on purpose —
// tsc emits the typed ESM for npm consumers, esbuild emits the thing a
// merchant pastes into a storefront. `--serve` additionally watches and
// serves the package root so /demo/ is a live playground.

import * as esbuild from 'esbuild';

const options = {
  entryPoints: ['src/embed.ts'],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'iife',
  target: ['es2020'],
  outfile: 'dist/kept-widget.js',
  logLevel: 'info',
};

if (process.argv.includes('--serve')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const served = await ctx.serve({ servedir: '.', port: 4173 });
  const host = served.hosts?.[0] ?? served.host ?? 'localhost';
  console.log(`\nkept-widget demo: http://${host}:${served.port}/demo/\n`);
} else {
  await esbuild.build(options);
}
