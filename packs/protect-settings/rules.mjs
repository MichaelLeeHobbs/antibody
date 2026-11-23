// protect-settings (opt-in): asks before a session changes Claude Code's settings.json or
// settings.local.json. This is access control, not a failure rule: it comes from no recorded
// failure, and Claude Code's own permission flow already covers it. It is here for anyone who wants
// antibody to put a person in front of settings edits too (issue #22 moved it out of core).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../lib/config.mjs';
import { norm, tildeOf, writesTo } from '../core/rules.mjs';

const isSettings = (p, loose) => {
  const n = norm(p);
  if (loose) return /settings(\.local)?\.json/.test(n) && n.includes('.claude');
  const t = tildeOf(n);
  return /^(~\/\.claude|\.claude)\/settings(\.local)?\.json$/.test(t) || /(^|\/)\.claude\/settings(\.local)?\.json$/.test(n);
};

export default [
  {
    id: 'protect-settings.write',
    tools: ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit'],
    get action() { return config().protect.settings; },
    message: 'This changes Claude Code settings (permissions and hooks). The protect-settings pack leaves that to a person: say what you want changed and why, and let them make or approve the edit.',
    check(ctx) {
      // `antibody permissions --apply` writes settings.json too.
      const applies = ctx.stages.some((st) => {
        const i = st.name === 'antibody' ? 0 : st.name === 'node' ? st.argv.findIndex((a) => /antibody(\.mjs)?$/i.test(a)) : -1;
        return i >= 0 && st.argv[i + 1] === 'permissions' && st.argv.includes('--apply');
      });
      return applies || writesTo(ctx, (p, loose) => isSettings(p, loose)) ? { action: config().protect.settings, message: this.message } : null;
    },
    cases: {
      fire: [
        { tool: 'Edit', file_path: '/home/u/.claude/settings.json' },
        'echo {} > ~/.claude/settings.json',
        'echo {}>~/.claude/settings.json',
        { command: 'cp x.json settings.json', cwd: join(homedir(), '.claude') },
        { tool: 'PowerShell', command: 'Set-Content -Value "a\nb" `\n -Path $HOME/.claude/settings.json' },
        'cp x.json ~/.claude/settings.local.json',
        `node -e "require('fs').writeFileSync(require('os').homedir()+'/.claude/settings.json','{}')"`,
        { tool: 'PowerShell', command: 'Set-Content -Path $HOME/.claude/settings.json -Value "{}"' },
        `python3 -c "import json,os; p=os.path.expanduser('~/.claude/settings.json'); d=json.load(open(p)); json.dump(d, open(p,'w'))"`,
        `perl -pi -e 's/a/b/' ~/.claude/settings.json`,
        `python -c "import os; f=open(os.path.expanduser('~/.claude/settings.json'), mode='a'); f.close()"`,
        'antibody permissions --apply',
        'node "C:/Users/u/.claude/plugins/cache/antibody/antibody/0.2.0/bin/antibody.mjs" permissions --apply',
        { tool: 'PowerShell', command: 'antibody permissions --apply' },
      ],
      pass: ['cat ~/.claude/settings.json',
        `node -e "const s=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/settings.json','utf8')); console.log(s.permissions)"`,
        `python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude/settings.json')))['permissions'])"`,
        'antibody permissions',
        `node -e "const p=require('os').homedir()+'/.claude/settings.json'; Object.keys(JSON.parse(require('fs').readFileSync(p,'utf8'))).forEach((k) => console.log(k))"`,
        { tool: 'PowerShell', command: 'Get-Content $HOME/.claude/settings.json | ConvertFrom-Json' }, 'cp ~/.claude/settings.json /tmp/settings-backup.json', 'grep -n hooks ~/.claude/settings.json', { tool: 'Edit', file_path: '/repo/src/settings.json' }, 'node script.mjs ~/.claude/settings.json'],
    },
  },
];
