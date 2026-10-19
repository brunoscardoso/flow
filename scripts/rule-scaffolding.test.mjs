import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const guidePath = '.claude/resources/core/pattern-authoring-guide.md';
const read = (path) => readFileSync(resolve(root, path), 'utf8');
// Relocation baseline: existing project rules retain their numbers and bodies.
// Update an individual digest only when intentionally editing that authored rule.
// Trailing separators/whitespace are excluded so adding the next rule is harmless.
const preservedRules = {
  "allowed": {
    "6": "9f4664481a6e17a477550ea1a5fb72096ad81af9ca092d3c962ffc7efeebf30e",
    "7": "c587ec042d3a0c3c66f040a873e82fdbd35caf9689d7e4751edde537b8b99100",
    "8": "f74b119d5bc1ae9d610d1183b6674ee7bfb7b0d4e19efc2c773c68ddc5b30d45",
    "9": "621675a45368a74efd59b47f8caf2f6dff5b85d4ca0b88a0809518e86b223a96",
    "10": "e70c85de07311ddffd1626f88f150151eafec166db8a0c7a1ca8aa122b26313f",
    "11": "6e8f85d6c8dd3ddc58152e22f1b8cdf890864b9fcd5cd07c27eb2c3ba1640668",
    "12": "eea3b17d651c1eba5001231148144e55bd202a88310a014bd56f5c4cfa923677",
    "13": "9197879ad61d5fec83ed056991b8d2eddb5bbb907ea74d3528af42ba83552538",
    "14": "36fd2a85b7a598746cd29dfb3273202bf42bc28eaef542960dda942b942c5782",
    "15": "db0bc58c259bc3a8f3e74263d0df476664c0950e20c5b3f9c5343874c0fa63a6",
    "16": "56499a0c4cfd492af643744df68de10efe27cba39e565410de1f1e6a7fa5b427",
    "17": "1791411b18d31fb7f741f77f9bad25bdcf2999a474bb6e3ffc38706e037271e4",
    "18": "1deded32f634be13d3126da4eda1eaab5d456069f29a649825b57c4063666e52",
    "19": "3ce26295f5640019f87307d0a33f41d5fd9480cf285d373cfb449a88c2c208fd",
    "20": "04bad87cd18ed48f394103498903d400d57dbdc84beb090e416c3f6f7eefa1de",
    "21": "d0005791fd484ec4ffbba0be46f4d1cd03da0978d559952acc72505a79821df6",
    "22": "9e26441c7dc1907cbadb85c924dd8f28d1e4db2ee03197a9e7951377a8f29d0c",
    "23": "f7036e0c4af8fa6d9f4a97590aec5b40a8765433f72de98a7fe81826a5afb4c8",
    "24": "7dbd5b0aeac5545c20bd17c34692c2f9ce1e02075ae90e4ddd840ea6cc6057b7",
    "25": "90f1984b7bc723b8d22a37a9f3cbc6e2720a91ce391b244de3094339477d4d6c",
    "26": "2efc1f81af63f699829eaf3526b20dfa2eca185703434e1cf1b26094edc466b5",
    "27": "431fd1735f01bc3651c5c51da663d0dd9c8de0a4eb622f13368bda36ef70d768",
    "28": "b02d91c70ce434f636c2d191d90d11b74b1f98393bfd2f042da66e07a7215653"
  },
  "forbidden": {
    "6": "1b000b0c65025db9489c6daa2285d54047df2561822ca66ed7a0250945e3a580",
    "7": "d0e60cb2abd107a39178021d5b9ba356a0573368d8eec4c255f8de7ca891f946",
    "8": "1454ebcc25796e5ab6de69c0881a337199277adb5bc6c3de2800de6e5d5783b6",
    "9": "1049f08b16c6d1f25cce55752660399625d8b905468c88441a670ce4f1fe22a3",
    "10": "be42cf10ad1ff8dced44b2661d6d081a0c02f9e864e03115b936b2760572a437",
    "11": "858be26d6a04050e82b8868ea3e64ab958d78ab5eff633d98f82889511f4745f",
    "12": "1b600107b5b9f7e5057f5b9b2b7d7930091c5071afd950e937672671f7142094",
    "13": "84570c56d556d23f9a61f3d012e2911e52d606ac9cb3357e4e7c274139fa2227",
    "14": "bc852d75ea678f89ed9d20e5463158f79ab5cbdbbf55be449ff85034edb7c63a",
    "15": "468e4fba6b12a538690c4b7d0730c457b761255ff0439eb58af7b287c7a2c4d7",
    "16": "134f0f7869c9051ef8ddea8d814f5b7637192eef18742af738742d32d666fd55",
    "17": "43dc1d942daebd905826b9601debd141faa73a04bb03002c942bf2ff24e605ef",
    "18": "0f6764e1d177eeaa508c90cb4378038ef92974821ff8c83339f49f8b0bb0c516",
    "19": "646dca0ef3ee268eae887e2b4e498d8f45ca91cc2fa8c51897f8bb1881beaf28",
    "20": "771ab6b00ef3874b632d37c13b300342c87768ce58c73464e1158cf1140d8e96",
    "21": "4e392b9159a3ae2d061433a17f558d047e947b9c90e65c1c7c02c3dcc5400310",
    "22": "a1f751752b20b084e82dd2e4239cfecebb53a95752eb8f8078e7997ca30cf431",
    "23": "fe3bfad84d099bffc96b1d6c6777d956ec206fd9bbf5a7c82c1a1f81ac26ca02"
  }
};

function projectRules(body) {
  return new Map([...body.matchAll(/^### (\d+)\. [\s\S]*?(?=^### \d+\. |$(?![\s\S]))/gm)]
    .filter((match) => Number(match[1]) >= 6)
    .map((match) => [match[1], match[0].replace(/\n---\s*$/, '').trimEnd()]));
}

for (const kind of ['allowed', 'forbidden']) {
  const path = `.claude/rules/core/${kind}-patterns.md`;
  test(`${kind} automatic rules exclude authoring scaffolding and generic examples`, () => {
    const body = read(path);
    assert.doesNotMatch(body, /^## (?:How to Use|Example|Adding Your|Template for)/m);
    assert.doesNotMatch(body, /^### [1-5]\. /m);
    const link = body.match(/\[pattern authoring guide\]\(([^)]+)\)/)?.[1];
    assert.ok(link, 'Authors need an on-demand guide link');
    assert.equal(resolve(root, dirname(path), link), resolve(root, guidePath));
    assert.match(body, /only when authoring or updating patterns/);
  });

  test(`${kind} project rule numbers and bodies survive the relocation`, () => {
    const body = read(path);
    const rules = projectRules(body);
    const headings = [...body.matchAll(/^### (\d+)\. /gm)].map((match) => match[1]);
    assert.equal(new Set(headings).size, headings.length, 'Rule numbers must be unique');
    for (const [number, digest] of Object.entries(preservedRules[kind])) {
      assert.ok(rules.has(number), `Missing ${kind} rule #${number}`);
      assert.equal(createHash('sha256').update(rules.get(number)).digest('hex'), digest,
        `${kind} rule #${number} changed; review authored-rule changes explicitly`);
    }
  });
}

test('generic examples and templates remain available outside automatically loaded rules', () => {
  const guide = read(guidePath);
  assert.match(guide, /## Allowed-pattern authoring/);
  assert.match(guide, /## Forbidden-pattern authoring/);
  assert.match(guide, /## Template for New Patterns/);
  assert.match(guide, /## Template for New Anti-Patterns/);
  for (let number = 1; number <= 5; number++) {
    assert.equal([...guide.matchAll(new RegExp(`^### ${number}\\. `, 'gm'))].length, 2);
  }
  assert.doesNotMatch(guide, /^### (?:[6-9]|[1-9]\d+)\. /m);
  // Provisioning identifies legacy rules by resource basename. A collision
  // would delete the authored rule even though the document move looks safe.
  const ruleNames = readdirSync(resolve(root, '.claude/rules/core'));
  assert.ok(!ruleNames.includes('pattern-authoring-guide.md'));
  for (const kind of ['allowed', 'forbidden']) {
    assert.ok(!readdirSync(resolve(root, '.claude/resources/core')).includes(`${kind}-patterns.md`));
  }
});
