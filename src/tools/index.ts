export { ToolRegistry } from './registry.js';
// Built-ins are exposed through this package boundary for embedding. The
// legacy infra path remains as a compatibility import for the coordinator.
export {
  executeTool,
  getToolPolicy,
  listTools,
  setToolPolicy,
  toolRegistry,
  TOOLS,
  WORKER_TOOLS,
} from '../infra/tools.js';
export type { BuiltinToolContext, OllamaToolDef } from '../infra/tools.js';
export type {
  RegisteredTool,
  ToolArguments,
  ToolDefinition,
  ToolEffect,
  ToolExecutionContext,
  ToolHandler,
  ToolMetadata,
  ToolParameterSchema,
} from './types.js';
