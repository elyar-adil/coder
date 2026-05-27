import { resolve, isAbsolute } from 'node:path';

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
    bashDenylist: ['rm -rf /', 'curl | sh', 'wget | sh', 'mkfs', ':(){:|:&};:'],
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
    return norm === root || norm.startsWith(root + '/');
  });
}

export function authorizeToolCall(policy: ToolPolicy, name: string, args: Record<string, unknown>): PolicyDecision {
  if (policy.level === 'off') return { ok: true };

  if (name === 'read_file' || name === 'write_file' || name === 'edit_file' || name === 'list_dir') {
    const path = typeof args['path'] === 'string' ? args['path'] : '.';
    const target = isAbsolute(path) ? path : resolve(policy.workspaceRoot, path);
    const roots = name === 'write_file' || name === 'edit_file' ? policy.allowedWriteRoots : policy.allowedReadRoots;
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
    if (policy.level === 'strict' && !policy.bashAllowlist.some((ok) => cmd.startsWith(ok))) {
      return { ok: false, ruleId: 'bash_not_allowlisted', reason: `Command not allowlisted: ${cmd}` };
    }
  }

  return { ok: true };
}

export function formatPolicyError(name: string, decision: PolicyDecision): string {
  return `PolicyError: tool=${name}; rule=${decision.ruleId ?? 'unknown'}; reason=${decision.reason ?? 'blocked'}`;
}
