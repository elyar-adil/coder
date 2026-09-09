export const SLASH_COMMANDS = [
  { name: '/provider', description: 'Manage providers' },
  { name: '/model', description: 'Choose a model' },
  { name: '/aside', description: 'Queue an aside to fold into the next message' },
  { name: '/btw', description: 'Ask in a side conversation forked from this one' },
  { name: '/back', description: 'Return from a side conversation to the parent session' },
  { name: '/fork', description: 'Copy this conversation into a new saved session' },
  { name: '/goal', description: 'Set a standing goal for this session' },
  { name: '/cd', description: 'Switch the working directory' },
  { name: '/pwd', description: 'Show the working directory' },
  { name: '/worktree', description: 'Create or enter an isolated git worktree' },
  { name: '/worktree-list', description: 'List managed worktrees' },
  { name: '/worktree-exit', description: 'Return to the main checkout' },
  { name: '/worktree-remove', description: 'Remove a clean worktree (branch kept)' },
  { name: '/theme', description: 'Switch color theme' },
  { name: '/agents', description: 'Inspect agent specs' },
  { name: '/sessions', description: 'Open a saved conversation' },
  { name: '/new', description: 'Start a conversation' },
  { name: '/clear', description: 'Clear this conversation' },
  { name: '/compact', description: 'Summarize and archive older context' },
  { name: '/cancel', description: 'Stop current work' },
  { name: '/select', description: 'Native terminal selection' },
  { name: '/mouse', description: 'Toggle app mouse interaction' },
  { name: '/help', description: 'Open command palette' },
  { name: '/exit', description: 'Exit TokenMaw' },
  { name: '/quit', description: 'Exit TokenMaw' },
];

export function commandMatches(input: string) {
  if (!/^\/[^\s]*$/.test(input)) return [];
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(input.toLowerCase()));
}
