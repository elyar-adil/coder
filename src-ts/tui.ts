import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { MasterCoordinator } from './master.js';
import type { TaskMode } from './types.js';

export async function runTui(master: MasterCoordinator): Promise<void> {
  const rl = readline.createInterface({ input, output });
  console.log('Top-tier Coding Agent TUI');
  console.log('Commands: new, list, view, approve, help, exit');

  while (true) {
    const cmd = (await rl.question('agent> ')).trim();
    if (cmd === 'exit') break;

    if (cmd === 'help') {
      console.log('new: create new task');
      console.log('list: list tasks');
      console.log('view: show task detail');
      console.log('approve: execute a blocked plan task');
      continue;
    }

    if (cmd === 'new') {
      const userId = (await rl.question('user_id (owner label, e.g. alice): ')).trim() || 'anonymous';
      const mode = (await rl.question('mode (execute|plan|react): ')).trim() as TaskMode;
      const prompt = await rl.question('prompt: ');
      const taskId = await master.acceptPrompt(userId, prompt, mode || 'execute');
      console.log(`created task: ${taskId}`);
      continue;
    }

    if (cmd === 'list') {
      for (const t of master.listTasks()) {
        console.log(`${t.taskId} | ${t.userId} | ${t.mode} | ${t.status}`);
      }
      continue;
    }

    if (cmd === 'view') {
      const id = (await rl.question('task_id: ')).trim();
      const t = master.getTask(id);
      console.log(JSON.stringify(t ?? { error: 'not_found' }, null, 2));
      continue;
    }

    if (cmd === 'approve') {
      const id = (await rl.question('task_id: ')).trim();
      const ok = await master.executePlan(id);
      console.log(JSON.stringify({ taskId: id, accepted: ok }, null, 2));
      continue;
    }

    console.log('Unknown command. Type help.');
  }

  rl.close();
}
