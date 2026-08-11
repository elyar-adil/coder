/** Provider-neutral JSON schema used by chat-completion tool calling APIs. */
export interface ToolParameterSchema {
  type: string;
  description?: string;
  items?: ToolParameterSchema;
  enum?: string[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ToolParameterSchema>;
      required: string[];
    };
  };
}

export type ToolEffect = 'read' | 'write' | 'execute' | 'coordinate';

export interface ToolMetadata {
  effect: ToolEffect;
  category: 'filesystem' | 'search' | 'git' | 'shell' | 'agent';
  hidden?: boolean;
}

export interface ToolPatchFile {
  path: string;
  baseHash?: string;
  before?: string;
  after: string;
  diff?: string;
}

export interface ToolPatch {
  summary: string;
  files: ToolPatchFile[];
  verificationCommands: string[];
}

/**
 * Runtime services available to tools. All fields are optional so the toolkit
 * can run without importing coordinator or domain types.
 */
export interface ToolExecutionContext<TPolicy = unknown> {
  workspaceRoot?: string;
  artifactDir?: string;
  taskId?: string;
  sharedContext?: string;
  signal?: AbortSignal;
  policy?: TPolicy;
  spawnSubagent?: (prompt: string) => Promise<string>;
  collectSubagent?: (id: string) => Promise<string>;
  requestClarification?: (question: string, choices?: string[]) => Promise<string>;
  submitPatch?: (patch: ToolPatch) => Promise<string>;
  acquireWriteLock?: (path: string) => Promise<() => void | Promise<void>>;
  checkpoint?: (note: string) => Promise<void>;
}

export type ToolArguments = Record<string, unknown>;
export type ToolHandler<TContext extends ToolExecutionContext = ToolExecutionContext> = (
  args: ToolArguments,
  context?: TContext,
) => Promise<string>;

export interface RegisteredTool<TContext extends ToolExecutionContext = ToolExecutionContext> {
  definition: ToolDefinition;
  metadata: ToolMetadata;
  execute: ToolHandler<TContext>;
}
