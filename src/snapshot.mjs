import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/** 只绑定明确提交的文件；拒绝目录、符号链接及越出项目的路径。 */
export function snapshot(root, files) {
  if (!Array.isArray(files) || !files.length) throw new Error('需要提交至少一个成果文件');
  const base = realpathSync(root);
  const entries = [...new Set(files)].sort().map(file => {
    if (typeof file !== 'string' || isAbsolute(file)) throw new Error('成果路径必须相对项目目录');
    const path = resolve(base, file);
    const inside = candidate => {
      const rel = relative(base, candidate);
      if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel))
        throw new Error('成果路径越出项目目录');
    };
    inside(path);
    inside(realpathSync(path));
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error('成果必须是普通文件');
    return { path: relative(base, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  });
  return { files: entries, version: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}
