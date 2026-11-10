import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const driver = fileURLToPath(new URL('../runtime/pdf-annotations.py', import.meta.url));
const locks = new Map();
export async function pdfAnnotations(ref, dataDir, request, pythonOverride) {
    const key = ref.pdfPath.toLowerCase();
    const previous = locks.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
        const python = pythonOverride || (process.platform === 'win32'
            ? join(dirname(dataDir), '.venv-pdf2zh', 'Scripts', 'python.exe')
            : join(dirname(dataDir), '.venv-pdf2zh', 'bin', 'python'));
        if (!existsSync(python)) return { error: 'PDF 批注引擎不可用，请先安装翻译引擎', code: 'engine-missing' };
        const work = join(dataDir, '.dpr-annotations');
        await mkdir(work, { recursive: true });
        const id = randomUUID();
        const input = join(work, id + '.in.json'), output = join(work, id + '.out.json');
        try {
            await writeFile(input, JSON.stringify({ ...request, pdfPath: ref.pdfPath }), { encoding: 'utf8', mode: 0o600 });
            await new Promise((resolve, reject) => {
                const child = spawn(python, [driver, input, output], { windowsHide: true, stdio: 'ignore' });
                const timeout = setTimeout(() => { child.kill(); reject(new Error('PDF operation timed out')); }, 60000);
                child.once('error', () => { clearTimeout(timeout); reject(new Error('PDF engine unavailable')); });
                child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('PDF engine failed')); });
            });
            return JSON.parse(await readFile(output, 'utf8'));
        } catch {
            return { error: 'PDF 批注操作未确认，请重开核对文件及原始备份；请检查文件占用和引擎', code: 'io' };
        } finally {
            await Promise.all([input, output].map(p => rm(p, { force: true }).catch(() => {})));
        }
    });
    locks.set(key, task);
    try { return await task; }
    finally { if (locks.get(key) === task) locks.delete(key); }
}
