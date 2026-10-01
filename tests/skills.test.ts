import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { describeSkill, formatSkillCatalog, isValidSkillName, listSkills, readSkill, skillRoots } from '../src/infra/skills.js';
import { executeTool } from '../src/infra/tools.js';

let dir: string;
let workspace: string;
let user: string;
let builtin: string;

async function skill(root: string, file: string, text: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, file), text);
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'maw-skills-'));
  workspace = join(dir, 'ws');
  user = join(dir, 'user-skills');
  builtin = join(dir, 'builtin-skills');
  await skill(builtin, 'testing.md', '# Testing Skill\n\nUse this skill when writing or fixing tests.\n\n## Guidelines\n- be thorough\n');
  await skill(builtin, 'debugging.md', '# Debugging\n\nBuiltin debugging text.\n');
  await skill(user, 'debugging.md', '# Debugging\n\nUser debugging text.\n');
  await skill(join(workspace, '.coder', 'skills'), 'debugging.md', '---\ndescription: Project-specific debugging playbook\n---\nProject debugging text.\n');
  await skill(join(workspace, 'skills'), 'legacy.md', 'Legacy workspace skill.\n');
  await skill(builtin, 'not a skill.md', 'ignored: invalid name\n');
  await skill(builtin, 'notes.txt', 'ignored: not markdown\n');
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

const roots = (): string[] => skillRoots(workspace, { userDir: user, builtinDir: builtin });

describe('skill roots and precedence', () => {
  test('project beats user beats built-in; the legacy workspace skills dir is still read', async () => {
    assert.match((await readSkill('debugging', roots()))!, /Project debugging text/);
    const withoutProject = roots().filter((root) => !root.includes(join('.coder', 'skills')));
    assert.match((await readSkill('debugging', withoutProject))!, /User debugging text/);
    assert.match((await readSkill('debugging', [builtin]))!, /Builtin debugging text/);
    assert.match((await readSkill('legacy', roots()))!, /Legacy workspace skill/);
  });

  test('rejects names that could escape the skills directory', async () => {
    for (const bad of ['../secrets', 'a/b', '', 'x y', '.hidden']) {
      assert.equal(isValidSkillName(bad), false, bad);
      assert.equal(await readSkill(bad, roots()), undefined);
    }
  });
});

describe('listSkills and descriptions', () => {
  test('lists each name once, nearest root wins, invalid files are skipped, sorted', async () => {
    const skills = await listSkills(roots());
    assert.deepEqual(skills.map((entry) => entry.name), ['debugging', 'legacy', 'testing']);
    assert.equal(skills.find((entry) => entry.name === 'debugging')!.description, 'Project-specific debugging playbook');
    assert.ok(skills.find((entry) => entry.name === 'debugging')!.path.includes('.coder'));
  });

  test('description comes from frontmatter, else the first prose line (not the heading)', () => {
    assert.equal(describeSkill('---\ndescription: From frontmatter\n---\n# Title\nBody'), 'From frontmatter');
    assert.equal(describeSkill('# Title\n\nUse this skill when writing or fixing tests.\n'), 'When writing or fixing tests.');
    assert.equal(describeSkill('# Only a heading\n'), '');
    assert.ok(describeSkill(`# T\n\n${'long '.repeat(100)}`).length <= 160);
  });

  test('a missing skills directory is not an error', async () => {
    assert.deepEqual(await listSkills([join(dir, 'nope')]), []);
    assert.equal(formatSkillCatalog([]), '');
  });

  test('the catalog lists names with descriptions', async () => {
    const text = formatSkillCatalog(await listSkills(roots()));
    assert.match(text, /^\nAvailable skills:\n- debugging: Project-specific debugging playbook\n- legacy: Legacy workspace skill\.\n- testing: When writing or fixing tests\./);
    assert.match(text, /Load one when the task matches/);
  });
});

describe('load_skill tool', () => {
  test('loads a project skill from <workspace>/.coder/skills', async () => {
    const result = await executeTool('load_skill', { name: 'debugging' }, { workspaceRoot: workspace });
    assert.match(result, /Project debugging text/);
  });

  test('an unknown skill lists what is available; a bad name is refused', async () => {
    const missing = await executeTool('load_skill', { name: 'nope' }, { workspaceRoot: workspace });
    assert.match(missing, /^Error: skill "nope" not found\. Available: .*debugging/);
    assert.equal(await executeTool('load_skill', { name: '../x' }, { workspaceRoot: workspace }), 'Error: invalid skill name');
    assert.equal(await executeTool('load_skill', {}, { workspaceRoot: workspace }), 'Error: load_skill requires "name"');
  });
});
