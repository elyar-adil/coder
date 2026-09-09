export const SLASH_COMMANDS = [
  { name: '/provider', description: 'Manage providers' },
  { name: '/model', description: 'Choose a model' },
  { name: '/btw', description: 'Queue an aside to fold into the next message' },
  { name: '/goal', description: 'Set a standing goal for this session' },
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
