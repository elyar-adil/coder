export const SLASH_COMMANDS = [
  { name: '/provider', description: 'Manage providers' },
  { name: '/model', description: 'Choose a model' },
  { name: '/agents', description: 'Inspect agent specs' },
  { name: '/sessions', description: 'Open a saved conversation' },
  { name: '/new', description: 'Start a conversation' },
  { name: '/clear', description: 'Clear this conversation' },
  { name: '/cancel', description: 'Stop current work' },
  { name: '/select', description: 'Native terminal selection' },
  { name: '/mouse', description: 'Toggle app mouse interaction' },
  { name: '/help', description: 'Open command palette' },
  { name: '/exit', description: 'Exit Coder' },
  { name: '/quit', description: 'Exit Coder' },
];

export function commandMatches(input: string) {
  if (!/^\/[^\s]*$/.test(input)) return [];
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(input.toLowerCase()));
}
