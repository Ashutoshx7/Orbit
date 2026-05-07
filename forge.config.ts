import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Helper: recursively copy a directory
// ---------------------------------------------------------------------------
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: get all transitive production deps for a set of package names
// ---------------------------------------------------------------------------
function collectDeps(names: string[], nmDir: string, visited = new Set<string>()): Set<string> {
  for (const name of names) {
    if (visited.has(name)) continue;
    visited.add(name);
    const pkgJson = path.join(nmDir, name, 'package.json');
    if (fs.existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
        const sub = Object.keys(pkg.dependencies || {});
        collectDeps(sub, nmDir, visited);
      } catch { /* ignore malformed package.json */ }
    }
  }
  return visited;
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      // Unpack native .node addons — they cannot be loaded from inside an asar archive.
      unpack: '{**/*.node,**/better-sqlite3/**,**/@ghostery/**}',
    },
    name: 'Astra',
    executableName: 'astra',
    appVersion: '1.0.0',
    icon: './assets/icon',
  },
  // ---------------------------------------------------------------------------
  // Hook: copy ALL production dependencies into the packaged app before asar.
  //
  // Why this is needed:
  //   Vite bundles most JS but can't handle:
  //     1. Native addons (.node files) — e.g. better-sqlite3
  //     2. Packages with dynamic require() at runtime — e.g. @ghostery/adblocker-electron
  //        which internally requires '@ghostery/adblocker-electron-preload' at runtime.
  //   electron-packager's dep walker only sees what Vite's bundle references — it
  //   misses externalized packages AND their transitive runtime dependencies.
  //   Solution: copy ALL production deps + their full transitive closure.
  // ---------------------------------------------------------------------------
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
      const nmDir = path.join(__dirname, 'node_modules');
      const topLevel = Object.keys(rootPkg.dependencies || {});

      // Collect the full transitive closure of production dependencies
      const allDeps = collectDeps(topLevel, nmDir);

      console.log(`[Astra] 📦 Copying ${allDeps.size} production dependencies into package...`);
      let copied = 0;
      let skipped = 0;

      for (const dep of allDeps) {
        const src = path.join(nmDir, dep);
        const dest = path.join(buildPath, 'node_modules', dep);

        if (!fs.existsSync(src)) { skipped++; continue; }
        if (fs.existsSync(dest)) { skipped++; continue; } // already copied by packager

        try {
          copyDirSync(src, dest);
          copied++;
        } catch (err) {
          console.warn(`[Astra] ⚠️ Could not copy ${dep}:`, err);
        }
      }

      console.log(`[Astra] ✅ Copied ${copied} deps, skipped ${skipped} (already present)`);
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    // RPM maker removed to avoid requiring `rpmbuild` on this system.
    new MakerDeb({
      options: {
        name: 'astra',
        productName: 'Astra',
        description: 'Fast, private, and beautiful web browser',
        productDescription: 'Astra is a fast, private browser built on Electron with features inspired by Zen and Helium browsers — including workspaces, split-view, link glance preview, ad blocking, and fingerprint protection.',
        homepage: 'https://github.com/ashutoshx7/Astra',
        maintainer: 'ashutoshx7',
        section: 'web',
        priority: 'optional',
        categories: ['Network', 'WebBrowser'],
        mimeType: ['x-scheme-handler/http', 'x-scheme-handler/https'],
      },
    }),
  ],
  plugins: [
    // AutoUnpackNatives: detects all .node files and ensures they're unpacked from the asar
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // These must be false: native modules live in app.asar.unpacked/, not inside the asar
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    }),
  ],
};

export default config;
