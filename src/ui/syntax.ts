import blessed from 'blessed';

/** Small lexical highlighter. Unknown languages remain readable plain text.
 * Colors come from the active theme: comment, string, keyword, attr, number. */
export function highlightCode(source: string, colors: readonly string[] = ['#84918b', '#cead83', '#ba9ce0', '#87b9db', '#d493b5']): string {
  const pattern = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--.*?-->)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:const|let|var|function|return|if|else|for|while|class|import|from|export|async|await|new|true|false|null|undefined|def|print|in|None|True|False|public|private|interface|type)\b)|(<\/?[\w-]+|\b[\w-]+(?=\s*=))|(\b\d+(?:\.\d+)?(?:px|em|rem|%)?\b)/g;
  let result = '';
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    result += blessed.escape(source.slice(offset, match.index));
    const color = colors[match.slice(1).findIndex(value => value !== undefined)]!;
    result += `{${color}-fg}${blessed.escape(match[0])}{/${color}-fg}`;
    offset = match.index! + match[0].length;
  }
  return result + blessed.escape(source.slice(offset));
}
