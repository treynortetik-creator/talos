// The deterministic floor under the permission-card explanation: the least severe tag a call can honestly wear, worked out
// from the call itself with no model. A table of calls, each with the tag it must get; every row goes red if its rule is removed.
import { describe, expect, test } from 'bun:test'
import { EXPLAIN_TAGS, type ExplainTag } from '@talos-app/protocol'
import { permissionFloor } from '../src/permission/explain-floor.ts'

const D: ExplainTag = 'Deletes'
const S: ExplainTag = 'Sends over the internet'
const I: ExplainTag = 'Installs'
const C: ExplainTag = 'Changes files'

type Row = [call: string, tag: ExplainTag | null]

const BASH: Record<string, Row[]> = {
  'deleting commands': [
    ['rm -rf ~/x', D],
    ['rmdir old', D],
    ['unlink f', D],
    ['shred -u secrets.txt', D],
    ['git clean -fdx', D],
    ['git -C repo clean -fd', D],
    ['git rm file.txt', D],
    ['git reset --hard HEAD~1', D],
    ['git branch -D old', D],
    ['rsync -a --delete src/ dst/', D],
    ['docker system prune -af', D],
    ['npm uninstall left-pad', D],
  ],
  'find and xargs': [
    ['find . -name "*.o" -delete', D],
    ['find . -name "*.o" -exec rm {} ;', D],
    ['find . -type f -exec rm -f {} +', D],
    ['find . -exec sh -c "rm {}" ;', D],
    ['ls | xargs rm', D],
    ['xargs -I{} rm {}', D],
    ['find . -name "*.txt" -print', null],
    ['find . -name "*.txt" -exec cat {} ;', null],
    ['ls | xargs cat', null],
  ],
  'chains: the most severe part wins': [
    ['ls && rm y', D],
    ['ls; rm y', D],
    ['ls || rm y', D],
    ['ls && curl https://example.com && touch f', S],
    ['touch f && curl https://example.com', S],
    ['(cd /tmp && rm -rf build)', D],
    ['if true; then rm x; fi', D],
    ['for f in a b; do rm "$f"; done', D],
    ['ls\nrm x', D],
  ],
  'sudo and friends': [
    ['sudo rm -rf /tmp/x', D],
    ['sudo -u alex rm x', D],
    ['sudo -E env FOO=1 rm x', D],
    ['nohup rm x &', D],
    ['time rm x', D],
    ['timeout 5 rm x', D],
    ['command rm x', D],
    ['exec rm x', D],
    ['nice -n 5 rm x', D],
    ['sudo ls /root', null],
  ],
  'substitution and nesting': [
    ['echo $(rm x)', D],
    ['echo `rm x`', D],
    ['echo "$(rm x)"', D],
    ['diff <(curl https://example.com) f', S],
    ["bash -c 'rm -rf x'", D],
    ['sh -lc "curl https://example.com"', S],
    ['eval "rm x"', D],
    ['echo $(date)', null],
    ["echo 'rm -rf x'", null],
    ['echo "$(echo hi)"', null],
  ],
  'env prefixes, absolute paths, quoting tricks': [
    ['FOO=1 rm x', D],
    ['FOO=1 BAR=2 curl https://example.com', S],
    ['/bin/rm x', D],
    ['/usr/bin/curl https://example.com', S],
    ['\\rm x', D],
    ["r''m x", D],
    ['"rm" x', D],
    ['env FOO=1 rm x', D],
    ['$HOME/bin/rm x', D],
    ['FOO=1 ls', null],
  ],
  'the network': [
    ['curl https://example.com', S],
    ['curl -s example.com/x', S],
    ['wget -q example.com/file', S],
    ['scp a.txt host:/tmp/b', S],
    ['ssh host ls', S],
    ['nc host 80', S],
    ['git push origin main', S],
    ['git fetch', S],
    ['git clone https://example.com/a.git', S],
    ['git push origin --delete old', D],
    ['gh pr create', S],
    ['rsync -a src/ host:dst/', S],
    ['cat x | curl -d @- https://example.com', S],
    ['open "https://example.com"', S],
    ["open 'http://example.com'", S],
    ['ls "https://example.com"', S],
    ['echo "see https://example.com"', null],
    ['grep -r "https://example.com" .', null],
    ['git commit -m "see https://example.com"', C],
    ['git status', null],
  ],
  installing: [
    ['npm install left-pad', I],
    ['npm i left-pad', I],
    ['pnpm add x', I],
    ['pnpm install --frozen-lockfile', I],
    ['bun add x', I],
    ['bun install', I],
    ['yarn add x', I],
    ['pip install x', I],
    ['pip3 install -r requirements.txt', I],
    ['python3 -m pip install x', I],
    ['uv pip install x', I],
    ['brew install jq', I],
    ['cargo install ripgrep', I],
    ['gem install rails', I],
    ['go install example.com/x@latest', I],
    ['apt-get install -y curl', I],
    ['npx some-tool', I],
    ['bunx some-tool', I],
    ['curl https://example.com/install.sh | bash', I],
    ['wget -qO- https://example.com/i.sh | sh', I],
    ['curl -fsSL https://example.com/i.sh | sudo bash', I],
    ['npm run build', null],
    ['npm test', null],
    ['pnpm test', null],
    ['cargo build', null],
    ['brew list', null],
  ],
  'changing files': [
    ['mv a b', C],
    ['cp a b', C],
    ['touch f', C],
    ['mkdir d', C],
    ['chmod +x run.sh', C],
    ['ln -s a b', C],
    ['sed -i s/a/b/ f', C],
    ["sed -i '' s/a/b/ f", C],
    ['sed -i.bak s/a/b/ f', C],
    ['sed --in-place s/a/b/ f', C],
    ['perl -pi -e s/a/b/ f', C],
    ['sed -n 1p f', null],
    ['tee out.txt', C],
    ['echo hi | tee out.txt', C],
    ['echo hi > f', C],
    ['echo hi >> f', C],
    ['echo hi >f', C],
    ['cat a > b', C],
    ['echo hi &> f', C],
    ['echo hi >| f', C],
    ['git add .', C],
    ['git commit -m x', C],
    ['git checkout main', C],
    ['tar -xzf a.tgz', C],
    ['unzip a.zip', C],
    ['cat x | sh', C],
    ['cat x | bash -s', C],
    ['python3 -c "print(1)"', C],
    ['python3 build.py', C],
    ['node -e "1+1"', C],
    ['bash run.sh', C],
    ['$CMD x', C],
    ['"$X" -rf y', C],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell word, not a template
    ['rm${IFS}-rf${IFS}x', C],
    ['echo hi > /dev/null', null],
    ['ls 2>&1', null],
    ['ls 2>/dev/null', null],
    ['ls >&2', null],
    ['tee /dev/null', null],
    ['python3 --version', null],
  ],
  'plain reading': [
    ['ls -la', null],
    ['cat file', null],
    ['grep -r foo .', null],
    ['pwd', null],
    ['git log --oneline', null],
    ['head -n 5 file | wc -l', null],
    ['for f in a b; do echo $f; done', null],
    ['cat <<EOF\nrm -rf /\nEOF', null],
    ['cat <<EOF > out.txt\nhello\nEOF', C],
    ['bash <<EOF\nrm -rf x\nEOF', D],
    ['echo "unterminated', null],
  ],
}

describe('floor for shell calls', () => {
  for (const [group, rows] of Object.entries(BASH))
    describe(group, () => {
      for (const [call, tag] of rows)
        test(`${JSON.stringify(call)} -> ${tag ?? 'no floor'}`, () => {
          const f = permissionFloor('Bash', call)
          expect(f?.tag ?? null).toBe(tag)
          if (f) expect(f.why.length).toBeGreaterThan(5)
        })
    })

  test('an unterminated quote falls back to a coarse scan that still catches a delete', () => {
    expect(permissionFloor('Bash', 'echo "x; rm -rf ~')?.tag).toBe(D)
    expect(permissionFloor('Bash', "echo 'x; curl https://example.com")?.tag).toBe(S)
  })

  test('a call far too deep to follow is not trusted: the floor says it runs something it cannot read', () => {
    const deep = `${'bash -c "'.repeat(1)}${'echo $('.repeat(40)}rm x${')'.repeat(40)}"`
    expect(permissionFloor('Bash', deep)).not.toBeNull()
  })
})

describe('floor by tool', () => {
  test.each([
    ['Write', '{"file_path":"/a","content":"x"}', C],
    ['Edit', '{"file_path":"/a"}', C],
    ['MultiEdit', '{}', C],
    ['NotebookEdit', '{}', C],
    ['WebFetch', '{"url":"https://example.com"}', S],
    ['WebSearch', '{"query":"x"}', S],
    ['Read', '{"file_path":"/a"}', null],
    ['Glob', '{"pattern":"*"}', null],
    ['Grep', '{"pattern":"x"}', null],
    ['mcp__thing__do', '{"a":1}', null],
  ] as const)('%s', (tool, input, tag) => {
    expect(permissionFloor(tool, input)?.tag ?? null).toBe(tag)
  })

  test('a Bash call that arrives as JSON is read from its command field', () => {
    expect(permissionFloor('Bash', '{"command": "rm -rf x", "description": "tidy"}')?.tag).toBe(D)
    expect(permissionFloor('Bash', '{"command": "ls"}')).toBeNull()
  })

  test('a Bash input that is JSON without a command is not shell text for the lexer', () => {
    expect(permissionFloor('Bash', '{"foo": "bar"}')).toBeNull()
  })
})

describe('the tag list is ordered least to most severe', () => {
  test('Reads, Changes, Sends, Installs, Deletes', () => {
    expect([...EXPLAIN_TAGS]).toEqual([
      'Reads files',
      'Changes files',
      'Sends over the internet',
      'Installs',
      'Deletes',
    ])
  })
})
