// Implements fs/read_text_file and fs/write_text_file.
//
// Relative paths resolve against the agent cwd. Absolute paths are allowed
// anywhere the process can access — same surface as terminal/* (which is not
// path-scoped). The old "agent workspace only" gate forced the model to fall
// back to shell for any real project work outside ~/.grok-remote/agents/.../cwd.

import fs from 'node:fs/promises';
import path from 'node:path';

export interface RpcError extends Error {
  rpc: { code: number; message: string };
}

export interface ReadTextFileParams {
  path?: string;
  limit?: number;
  line?: number;
}

export interface ReadTextFileResult {
  content: string;
}

export interface WriteTextFileParams {
  path?: string;
  content?: string;
}

export interface FsHostOptions {
  getCwd: () => string | null | undefined;
}

export interface FsHost {
  readTextFile(params: ReadTextFileParams): Promise<ReadTextFileResult>;
  writeTextFile(params: WriteTextFileParams): Promise<Record<string, never>>;
}

function rpcError(code: number, message: string): RpcError {
  const err = new Error(message) as RpcError;
  err.rpc = { code, message };
  return err;
}

export function createFsHost({ getCwd }: FsHostOptions): FsHost {
  function resolvePath(p: unknown): string {
    if (typeof p !== 'string' || !p.length) {
      throw rpcError(-32602, 'path must be a non-empty string');
    }
    const scope = getCwd();
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(scope || process.cwd(), p);
    return abs;
  }

  return {
    async readTextFile(params: ReadTextFileParams): Promise<ReadTextFileResult> {
      const target = resolvePath(params?.path);
      const content = await fs.readFile(target, 'utf8');
      const limit = params?.limit;
      const line = params?.line;
      if (typeof line === 'number' || typeof limit === 'number') {
        const lines = content.split('\n');
        const start = Math.max(0, (line || 1) - 1);
        const end = typeof limit === 'number' ? start + limit : lines.length;
        return { content: lines.slice(start, end).join('\n') };
      }
      return { content };
    },

    async writeTextFile(params: WriteTextFileParams): Promise<Record<string, never>> {
      const target = resolvePath(params?.path);
      const content = params?.content;
      if (typeof content !== 'string') {
        throw rpcError(-32602, 'content must be a string');
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
      return {};
    },
  };
}
