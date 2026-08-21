const { cpSync, existsSync, mkdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const source = join(process.cwd(), 'src', 'assets');
const target = join(process.cwd(), 'dist', 'assets');

if (existsSync(source)) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
}
