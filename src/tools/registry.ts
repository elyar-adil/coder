import type {
  RegisteredTool,
  ToolArguments,
  ToolDefinition,
  ToolExecutionContext,
  ToolMetadata,
} from './types.js';

/** Small, provider-neutral registry suitable for embedding outside the agent. */
export class ToolRegistry<TContext extends ToolExecutionContext = ToolExecutionContext> {
  readonly #tools = new Map<string, RegisteredTool<TContext>>();

  register(tool: RegisteredTool<TContext>): this {
    const name = tool.definition.function.name.trim();
    if (!name) throw new Error('Tool name cannot be empty');
    if (this.#tools.has(name)) throw new Error(`Tool already registered: ${name}`);
    if (tool.definition.function.parameters.type !== 'object') {
      throw new Error(`Tool parameters must be an object schema: ${name}`);
    }
    this.#tools.set(name, tool);
    return this;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): RegisteredTool<TContext> | undefined {
    return this.#tools.get(name);
  }

  definitions(options: { includeHidden?: boolean } = {}): ToolDefinition[] {
    return [...this.#tools.values()]
      .filter((tool) => options.includeHidden || !tool.metadata.hidden)
      .map((tool) => tool.definition);
  }

  describe(options: { includeHidden?: boolean } = {}): Array<{
    name: string;
    description: string;
    metadata: ToolMetadata;
  }> {
    return [...this.#tools.values()]
      .filter((tool) => options.includeHidden || !tool.metadata.hidden)
      .map((tool) => ({
        name: tool.definition.function.name,
        description: tool.definition.function.description,
        metadata: { ...tool.metadata },
      }));
  }

  async execute(name: string, args: ToolArguments, context?: TContext): Promise<string> {
    const tool = this.#tools.get(name);
    if (!tool) return `Error: unknown tool "${name}"`;
    if (context?.signal?.aborted) return 'Error: tool execution aborted';
    try {
      return await tool.execute(args, context);
    } catch (error) {
      if (context?.signal?.aborted) return 'Error: tool execution aborted';
      return `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
