import { resolve, isAbsolute, relative } from 'node:path';

export type PolicyLevel = 'strict' | 'moderate' | 'off';

export interface ToolPolicy {
  level: PolicyLevel;
  workspaceRoot: string;
  allowedReadRoots: string[];
  allowedWriteRoots: string[];
  bashAllowlist: string[];
  bashDenylist: string[];
}

export interface PolicyDecision {
  ok: boolean;
  ruleId?: string;
  reason?: string;
}

export function clonePolicy(policy: ToolPolicy): ToolPolicy {
  return {
    level: policy.level,
    workspaceRoot: policy.workspaceRoot,
    allowedReadRoots: [...policy.allowedReadRoots],
    allowedWriteRoots: [...policy.allowedWriteRoots],
    bashAllowlist: [...policy.bashAllowlist],
    bashDenylist: [...policy.bashDenylist],
  };
}

export function defaultPolicy(level: PolicyLevel = 'off', workspaceRoot = process.cwd()): ToolPolicy {
  return {
    level,
    workspaceRoot,
    allowedReadRoots: [workspaceRoot],
    allowedWriteRoots: [workspaceRoot],
    bashAllowlist: ['npm test', 'npm run typecheck', 'npm run build', 'node --version', 'echo '],
    bashDenylist: [
      'rm -rf /', 'curl | sh', 'wget | sh', 'mkfs', ':(){:|:&};:',
      'Remove-Item -Recurse C:\\', 'format C:', 'diskpart',
    ],
  };
}

export function readOnlyPolicy(base: ToolPolicy): ToolPolicy {
  const policy = clonePolicy(base);
  policy.allowedWriteRoots = [];
  return policy;
}

function withinRoots(target: string, roots: string[]): boolean {
  const norm = resolve(target);
  return roots.some((r) => {
    const root = resolve(r);
    if (norm === root) return true;
    // Use path.relative for cross-platform safety: on Windows, resolve()
    // returns backslash-separated paths, so a naive `startsWith(root + '/')`
    // check fails and wrongly rejects in-workspace files.
    const rel = relative(root, norm);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
}

export function authorizeToolCall(policy: ToolPolicy, name: string, args: Record<string, unknown>): PolicyDecision {
  if (policy.level === 'off') return { ok: true };

  const readPathTools = new Set([
    'read_file', 'read_files', 'file_info', 'list_dir', 'search_text', 'search_files',
    'repo_map', 'git_diff', 'git_log',
  ]);
  const writePathTools = new Set(['write_file', 'edit_file']);
  if (readPathTools.has(name) || writePathTools.has(name)) {
    const key = name === 'repo_map' ? 'root' : 'path';
    const path = typeof args[key] === 'string' ? args[key] : '.';
    const target = isAbsolute(path) ? path : resolve(policy.workspaceRoot, path);
    const roots = writePathTools.has(name) ? policy.allowedWriteRoots : policy.allowedReadRoots;
    if (!withinRoots(target, roots)) {
      return { ok: false, ruleId: 'path_outside_workspace', reason: `Path not allowed: ${path}` };
    }
  }

  if (name === 'bash') {
    const cmd = typeof args['command'] === 'string' ? args['command'] : '';
    if (!cmd) return { ok: false, ruleId: 'missing_command', reason: 'bash command is required' };
    if (policy.bashDenylist.some((bad) => cmd.includes(bad))) {
      return { ok: false, ruleId: 'bash_denylist', reason: `Command blocked by denylist: ${cmd}` };
    }
    const cwdArg = typeof args['cwd'] === 'string' ? args['cwd'] : policy.workspaceRoot;
    const cwd = isAbsolute(cwdArg) ? cwdArg : resolve(policy.workspaceRoot, cwdArg);
    if (!withinRoots(cwd, policy.allowedReadRoots)) {
      return { ok: false, ruleId: 'cwd_outside_workspace', reason: `Working directory not allowed: ${cwdArg}` };
    }
    if (policy.level === 'strict' && !policy.bashAllowlist.some((ok) => cmd.startsWith(ok))) {
      return { ok: false, ruleId: 'bash_not_allowlisted', reason: `Command not allowlisted: ${cmd}` };
    }
  }

  return { ok: true };
}

export function formatPolicyError(name: string, decision: PolicyDecision): string {
  return `PolicyError: tool=${name}; rule=${decision.ruleId ?? 'unknown'}; reason=${decision.reason ?? 'blocked'}`;
}
