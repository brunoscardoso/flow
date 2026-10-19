/**
 * Tests for the tree-sitter storyline reader — every table read through the
 * real WebAssembly runtime and grammars: pieces (functions, classes, methods,
 * data structures), calls (local, self/this/receiver, imports resolved to
 * project files, package calls dropped, unknowns kept plain), type uses,
 * entries, docs, plus the refusals and the loader's fallbacks. Python is
 * covered in depth; Go, Rust, Java, C#, Ruby, PHP, C/C++ and Bash each get a
 * fixture of their own below.
 */

import { join } from 'node:path';
import {
  BASH,
  CPP,
  CSHARP,
  GO,
  JAVA,
  PHP,
  PYTHON,
  RUBY,
  RUST,
  STORYLINE_LANGUAGES,
  docCommentAbove,
  extractWithTreeSitter,
  prepareStorylineLanguages,
  resolveCppInclude,
  resolveGoImport,
  resolveJavaImport,
  resolvePhpImport,
  resolvePythonImport,
  resolveRustImport,
  storylineTableFor,
} from './storyline-languages.js';
import { TREESITTER_PATH_ENV, loadTreeSitter, openTreeSitter, type TreeSitterEngine } from './storyline-treesitter.js';
import type { StorylineAnswer, StorylinePiece, StorylineResult } from './storyline-types.js';

let engine: TreeSitterEngine;

beforeAll(async () => {
  const runtime = loadTreeSitter();
  if (runtime === null) throw new Error('the @vscode/tree-sitter-wasm devDependency must load for these tests');
  const started = await openTreeSitter(runtime);
  if (started === null) throw new Error('the tree-sitter runtime must start for these tests');
  engine = started;
  await prepareStorylineLanguages(
    engine,
    STORYLINE_LANGUAGES.map((language) => `any${language.extensions[0] ?? ''}`),
  );
});

function read(file: string, text: string, existing: string[] = []): StorylineAnswer {
  const files = new Set(existing);
  return extractWithTreeSitter({ engine, file, text, fileExists: (relPath) => files.has(relPath) });
}

function readOk(file: string, text: string, existing: string[] = []): StorylineResult {
  const answer = read(file, text, existing);
  if (!answer.ok) throw new Error(`expected a storyline, got ${answer.reason}: ${answer.sentence}`);
  return answer;
}

/** A project of files with text: exists, reads and lists — or, `readable: false`, only exists. */
function readProject(
  file: string,
  text: string,
  project: Record<string, string>,
  options: { readable?: boolean } = {},
): StorylineResult {
  const files: Record<string, string> = { ...project, [file]: text };
  const directoryOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.');
  const answer = extractWithTreeSitter({
    engine,
    file,
    text,
    fileExists: (relPath) => relPath in files,
    ...(options.readable === false
      ? {}
      : {
          readFile: (relPath: string) => files[relPath] ?? null,
          listDirectory: (relDir: string) => Object.keys(files).filter((path) => directoryOf(path) === relDir),
        }),
  });
  if (!answer.ok) throw new Error(`expected a storyline, got ${answer.reason}: ${answer.sentence}`);
  return answer;
}

/** `[local id, kind]` for every piece. */
function kindsOf(result: StorylineResult): Array<[string, string]> {
  return result.pieces.map((piece) => [piece.id.split('#')[1] ?? '', piece.kind]);
}

/** A piece's calls without `from`, with local ids shortened. */
function callsFrom(result: StorylineResult, name: string): Array<Record<string, unknown>> {
  const file = result.files[0] ?? '';
  return result.calls
    .filter((call) => call.from === `${file}#${name}`)
    .map(({ from: _from, to, ...rest }) => ({ ...rest, to: to === null ? null : to.split('#')[1] }));
}

function typeUsesOf(result: StorylineResult): string[] {
  return result.typeUses.map(({ from, to }) => `${from.split('#')[1]}->${to.split('#')[1]}`);
}

function entriesOf(result: StorylineResult): string[] {
  return result.entries.map((entry) => entry.pieceId.split('#')[1] ?? '');
}

function expectSyntaxError(file: string, text: string, line: number): void {
  const answer = read(file, text);
  expect(answer).toMatchObject({ ok: false, reason: 'syntax-error', file, text });
  if (!answer.ok) expect(answer.sentence).toContain(`line ${line} doesn't parse`);
}

function lines(...rows: string[]): string {
  return rows.join('\n');
}

function pieceNamed(result: StorylineResult, id: string): StorylinePiece {
  const piece = result.pieces.find((candidate) => candidate.id === id);
  if (piece === undefined) throw new Error(`no piece ${id}; have ${result.pieces.map((p) => p.id).join(', ')}`);
  return piece;
}

// ── (a) a service with methods, a sibling module and data structures ──

const SERVICE_FILE = 'app/orders/service.py';
const SERVICE = lines(
  /*  1 */ 'from __future__ import annotations',
  /*  2 */ 'import logging',
  /*  3 */ 'from dataclasses import dataclass',
  /*  4 */ 'from enum import Enum',
  /*  5 */ 'from .pricing import price_of, Discount as D',
  /*  6 */ 'from ..shared import audit',
  /*  7 */ 'from . import missing_mod',
  /*  8 */ '',
  /*  9 */ '',
  /* 10 */ 'class Status(Enum):',
  /* 11 */ '    """Where an order is. Second sentence."""',
  /* 12 */ '    OPEN = 1',
  /* 13 */ '    PAID = 2',
  /* 14 */ '',
  /* 15 */ '',
  /* 16 */ '@dataclass(frozen=True)',
  /* 17 */ 'class Order:',
  /* 18 */ '    id: str',
  /* 19 */ '    status: Status',
  /* 20 */ '',
  /* 21 */ '',
  /* 22 */ '# Totals an order.',
  /* 23 */ 'def total(order: Order) -> int:',
  /* 24 */ '    return price_of(order) + len(order.id)',
  /* 25 */ '',
  /* 26 */ '',
  /* 27 */ 'class OrderService:',
  /* 28 */ '    """Takes orders through payment."""',
  /* 29 */ '',
  /* 30 */ '    def __init__(self, repo: Repo, log: logging.Logger) -> None:',
  /* 31 */ '        self.repo = repo',
  /* 32 */ '',
  /* 33 */ '    @staticmethod',
  /* 34 */ '    def make(order_id: str) -> Order:',
  /* 35 */ '        return Order(order_id, Status.OPEN)',
  /* 36 */ '',
  /* 37 */ '    async def pay(self, order: Order) -> list[Order]:',
  /* 38 */ '        """Charge it."""',
  /* 39 */ '        amount = total(order)',
  /* 40 */ '        self._record(order)',
  /* 41 */ '        self.repo.save(order)',
  /* 42 */ '        audit.write(order)',
  /* 43 */ '        logging.info("paid")',
  /* 44 */ '        self.notify(order)',
  /* 45 */ '        mystery(amount)',
  /* 46 */ '        D(amount)',
  /* 47 */ '        def later():',
  /* 48 */ '            return helper()',
  /* 49 */ '        return [order]',
  /* 50 */ '',
  /* 51 */ '    @classmethod',
  /* 52 */ '    def build(cls) -> "OrderService":',
  /* 53 */ '        return cls.make("x")',
  /* 54 */ '',
  /* 55 */ '    def _record(self, order: Order) -> None:',
  /* 56 */ '        print(order)',
  /* 57 */ '',
  /* 58 */ '',
  /* 59 */ 'def helper():',
  /* 60 */ '    missing_mod.run()',
  /* 61 */ '    return OrderService.make("y")',
  /* 62 */ '',
  /* 63 */ '',
  /* 64 */ 'def _private():',
  /* 65 */ '    return helper()',
);
const SERVICE_FILES = ['app/orders/pricing.py', 'app/shared/audit.py'];

describe('Python: a service with methods, a sibling module and data structures', () => {
  let result: StorylineResult;
  beforeAll(() => {
    result = readOk(SERVICE_FILE, SERVICE, SERVICE_FILES);
  });

  it('reads as python, one file', () => {
    expect(result.language).toBe('python');
    expect(result.scope).toBe('file');
    expect(result.files).toEqual([SERVICE_FILE]);
  });

  it('draws functions, classes, methods and data structures in file order', () => {
    expect(result.pieces.map((piece) => [piece.id.split('#')[1], piece.kind])).toEqual([
      ['Status', 'enum'],
      ['Order', 'type'],
      ['total', 'function'],
      ['OrderService', 'class'],
      ['OrderService.__init__', 'method'],
      ['OrderService.make', 'method'],
      ['OrderService.pay', 'method'],
      ['OrderService.build', 'method'],
      ['OrderService._record', 'method'],
      ['helper', 'function'],
      ['_private', 'function'],
    ]);
  });

  it('keeps decorators in the piece and its lines', () => {
    const order = pieceNamed(result, `${SERVICE_FILE}#Order`);
    expect(order.startLine).toBe(16);
    expect(order.endLine).toBe(19);
    expect(order.text.startsWith('@dataclass(frozen=True)\nclass Order:')).toBe(true);
    const make = pieceNamed(result, `${SERVICE_FILE}#OrderService.make`);
    expect(make.startLine).toBe(33);
    expect(make.text.startsWith('@staticmethod')).toBe(true);
    expect(make.className).toBe('OrderService');
  });

  it('reads docstrings (first sentence) and falls back to a # comment directly above', () => {
    expect(pieceNamed(result, `${SERVICE_FILE}#Status`).doc).toBe('Where an order is.');
    expect(pieceNamed(result, `${SERVICE_FILE}#OrderService`).doc).toBe('Takes orders through payment.');
    expect(pieceNamed(result, `${SERVICE_FILE}#OrderService.pay`).doc).toBe('Charge it.');
    expect(pieceNamed(result, `${SERVICE_FILE}#total`).doc).toBe('Totals an order.');
    expect(pieceNamed(result, `${SERVICE_FILE}#helper`).doc).toBeNull();
  });

  it('marks the constructor and the class frame with its signature', () => {
    expect(pieceNamed(result, `${SERVICE_FILE}#OrderService.__init__`).isConstructor).toBe(true);
    expect(result.classes).toEqual([
      {
        name: 'OrderService',
        file: SERVICE_FILE,
        startLine: 27,
        constructorSignature: '__init__(self, repo: Repo, log: logging.Logger)',
      },
    ]);
  });

  it('exports by name: a leading underscore is private', () => {
    expect(pieceNamed(result, `${SERVICE_FILE}#helper`).exported).toBe(true);
    expect(pieceNamed(result, `${SERVICE_FILE}#_private`).exported).toBe(false);
    expect(pieceNamed(result, `${SERVICE_FILE}#OrderService._record`).exported).toBe(true);
  });

  it('draws only calls the syntax proves; the rest stay plain or are dropped', () => {
    const from = (name: string): string => `${SERVICE_FILE}#${name}`;
    const callsOf = (name: string) =>
      result.calls.filter((call) => call.from === from(name)).map(({ from: _from, ...rest }) => rest);

    expect(callsOf('total')).toEqual([
      { line: 24, to: null, external: { file: 'app/orders/pricing.py', name: 'price_of' } },
    ]);
    expect(callsOf('OrderService.make')).toEqual([{ line: 35, to: from('Order') }]);
    expect(callsOf('OrderService.pay')).toEqual([
      { line: 39, to: from('total') },
      { line: 40, to: from('OrderService._record') },
      { line: 42, to: null, external: { file: 'app/shared/audit.py', name: 'write' } },
      { line: 44, to: null, unresolvedName: 'self.notify' },
      { line: 45, to: null, unresolvedName: 'mystery' },
      { line: 46, to: null, external: { file: 'app/orders/pricing.py', name: 'Discount' } },
      { line: 48, to: from('helper') },
    ]);
    expect(callsOf('OrderService.build')).toEqual([{ line: 53, to: from('OrderService.make') }]);
    expect(callsOf('OrderService._record')).toEqual([]);
    // `missing_mod` names no project file: a value's method is not drawn. A class's own member is.
    expect(callsOf('helper')).toEqual([{ line: 61, to: from('OrderService.make') }]);
    expect(callsOf('_private')).toEqual([{ line: 65, to: from('helper') }]);
  });

  it('reads type hints and fields that name the data structures', () => {
    const uses = result.typeUses.map(({ from, to }) => [from.split('#')[1], to.split('#')[1]]);
    expect(uses).toEqual([
      ['Order', 'Status'],
      ['total', 'Order'],
      ['OrderService.make', 'Order'],
      ['OrderService.pay', 'Order'],
      ['OrderService._record', 'Order'],
    ]);
  });

  it('opens on the exported functions, classes and public methods, in file order', () => {
    expect(result.entries.map((entry) => entry.pieceId.split('#')[1])).toEqual([
      'total',
      'OrderService',
      'OrderService.make',
      'OrderService.pay',
      'OrderService.build',
      'helper',
    ]);
    expect(result.entries.every((entry) => entry.usedFrom === 0)).toBe(true);
  });
});

describe('Python: every data-structure form', () => {
  const FILE = 'a/models.py';
  const TEXT = lines(
    /*  1 */ 'import enum, dataclasses',
    /*  2 */ 'from typing import Protocol, TypedDict, NamedTuple',
    /*  3 */ 'from pydantic import BaseModel',
    /*  4 */ 'class Saver(Protocol):',
    /*  5 */ '    def save(self, row: "Row") -> None: ...',
    /*  6 */ 'class Row(TypedDict):',
    /*  7 */ '    id: int',
    /*  8 */ 'class Pt(NamedTuple):',
    /*  9 */ '    x: int',
    /* 10 */ 'class M(BaseModel):',
    /* 11 */ '    row: Row',
    /* 12 */ 'class Color(enum.IntEnum):',
    /* 13 */ '    RED = 1',
    /* 14 */ '@dataclasses.dataclass(slots=True)',
    /* 15 */ 'class Box:',
    /* 16 */ '    color: Color',
    /* 17 */ 'class Plain(Saver):',
    /* 18 */ '    def go(self, p: Pt | None, boxes: list[Box]) -> M:',
    /* 19 */ '        return M(row=p)',
    /* 20 */ '    @property',
    /* 21 */ '    def v(self): return 1',
    /* 22 */ '    @v.setter',
    /* 23 */ '    def v(self, x): pass',
  );

  it('reads Protocol as interface, Enum as enum, the rest as type', () => {
    const result = readOk(FILE, TEXT);
    expect(result.pieces.map((piece) => [piece.id.split('#')[1], piece.kind])).toEqual([
      ['Saver', 'interface'],
      ['Saver.save', 'method'],
      ['Row', 'type'],
      ['Pt', 'type'],
      ['M', 'type'],
      ['Color', 'enum'],
      ['Box', 'type'],
      ['Plain', 'class'],
      ['Plain.go', 'method'],
      ['Plain.v', 'method'],
      ['Plain.v~2', 'method'],
    ]);
  });

  it('follows hints through unions, generics, bases and quoted forward references', () => {
    const result = readOk(FILE, TEXT);
    expect(result.typeUses.map(({ from, to }) => `${from.split('#')[1]}->${to.split('#')[1]}`)).toEqual([
      'Saver.save->Row',
      'M->Row',
      'Box->Color',
      'Plain->Saver',
      'Plain.go->Pt',
      'Plain.go->Box',
      'Plain.go->M',
    ]);
    expect(result.calls).toEqual([{ from: `${FILE}#Plain.go`, line: 19, to: `${FILE}#M` }]);
  });

  it('frames a class with methods, data structures included', () => {
    expect(readOk(FILE, TEXT).classes.map((frame) => frame.name)).toEqual(['Saver', 'Plain']);
  });
});

// ── (b) imports: modules, aliases, absolute paths and __all__ ──

describe('Python: imports and explicit exports', () => {
  const FILE = 'src/pkg/api/handlers.py';
  const TEXT = lines(
    /*  1 */ 'import pkg.core.store as store',
    /*  2 */ 'import requests',
    /*  3 */ 'from pkg.core import rules',
    /*  4 */ 'from pkg.core.rules import check',
    /*  5 */ 'from . import views',
    /*  6 */ '',
    /*  7 */ '__all__ = ["handle"]',
    /*  8 */ '',
    /*  9 */ 'def handle(request):',
    /* 10 */ '    store.save(request)',
    /* 11 */ '    requests.get("u")',
    /* 12 */ '    rules.apply(request)',
    /* 13 */ '    check(request)',
    /* 14 */ '    views.render(request)',
    /* 15 */ '',
    /* 16 */ 'def public_but_unlisted():',
    /* 17 */ '    return handle(None)',
  );
  const EXISTING = ['src/pkg/core/store.py', 'src/pkg/core/rules.py', 'src/pkg/api/views.py'];

  it('resolves module bindings, absolute paths from an ancestor root, and drops packages', () => {
    const result = readOk(FILE, TEXT, EXISTING);
    const calls = result.calls.filter((call) => call.from === `${FILE}#handle`).map((call) => [call.line, call.external]);
    expect(calls).toEqual([
      [10, { file: 'src/pkg/core/store.py', name: 'save' }],
      [12, { file: 'src/pkg/core/rules.py', name: 'apply' }],
      [13, { file: 'src/pkg/core/rules.py', name: 'check' }],
      [14, { file: 'src/pkg/api/views.py', name: 'render' }],
    ]);
  });

  it('lets __all__ alone decide what is exported', () => {
    const result = readOk(FILE, TEXT, EXISTING);
    expect(pieceNamed(result, `${FILE}#handle`).exported).toBe(true);
    expect(pieceNamed(result, `${FILE}#public_but_unlisted`).exported).toBe(false);
    expect(result.entries.map((entry) => entry.pieceId)).toEqual([`${FILE}#handle`]);
  });
});

describe('resolvePythonImport', () => {
  const exists = (paths: string[]) => {
    const set = new Set(paths);
    return (relPath: string): boolean => set.has(relPath);
  };

  it('resolves relative specifiers from the file’s package, one dot per level', () => {
    const fileExists = exists(['a/b/x.py', 'a/y/__init__.py', 'a/__init__.py', 'a/y/z.py']);
    expect(resolvePythonImport('a/b/m.py', '.x', fileExists)).toBe('a/b/x.py');
    expect(resolvePythonImport('a/b/m.py', '..y', fileExists)).toBe('a/y/__init__.py');
    expect(resolvePythonImport('a/b/m.py', '..y.z', fileExists)).toBe('a/y/z.py');
    expect(resolvePythonImport('a/b/m.py', '..', fileExists)).toBe('a/__init__.py');
    expect(resolvePythonImport('a/b/m.py', '....far', fileExists)).toBeNull();
    expect(resolvePythonImport('a/b/m.py', '.nothing', fileExists)).toBeNull();
  });

  it('resolves absolute specifiers only to project files', () => {
    const fileExists = exists(['pkg/mod.py', 'src/lib/util.py']);
    expect(resolvePythonImport('pkg/other.py', 'pkg.mod', fileExists)).toBe('pkg/mod.py');
    expect(resolvePythonImport('src/lib/main.py', 'lib.util', fileExists)).toBe('src/lib/util.py');
    expect(resolvePythonImport('pkg/other.py', 'requests', fileExists)).toBeNull();
  });
});

// ── (c) the other languages — one fixture each ──

describe('Go: receivers, a package directory through go.mod, the same package', () => {
  const FILE = 'internal/orders/orders.go';
  const TEXT = lines(
    /*  1 */ 'package orders',
    /*  2 */ '',
    /*  3 */ 'import (',
    /*  4 */ '\t"fmt"',
    /*  5 */ '\t"example.com/shop/internal/pricing"',
    /*  6 */ '\tau "example.com/shop/internal/audit"',
    /*  7 */ ')',
    /*  8 */ '',
    /*  9 */ '// Status is where an order is.',
    /* 10 */ 'type Status int',
    /* 11 */ '',
    /* 12 */ '// Order is one purchase. Second sentence.',
    /* 13 */ 'type Order struct {',
    /* 14 */ '\tID     string',
    /* 15 */ '\tStatus Status',
    /* 16 */ '}',
    /* 17 */ '',
    /* 18 */ 'type Saver interface {',
    /* 19 */ '\tSave(o *Order) error',
    /* 20 */ '}',
    /* 21 */ '',
    /* 22 */ '// Total sums an order.',
    /* 23 */ 'func Total(o *Order) int {',
    /* 24 */ '\treturn pricing.PriceOf(o) + len(o.ID)',
    /* 25 */ '}',
    /* 26 */ '',
    /* 27 */ 'func (s *Service) Pay(o *Order) error {',
    /* 28 */ '\ts.record(o)',
    /* 29 */ '\tfmt.Println("paid")',
    /* 30 */ '\tau.Write(o)',
    /* 31 */ '\tpricing.Missing(o)',
    /* 32 */ '\tmystery(o)',
    /* 33 */ '\tshared(o)',
    /* 34 */ '\treturn s.notify(o)',
    /* 35 */ '}',
    /* 36 */ '',
    /* 37 */ 'func (s *Service) record(o *Order) {',
    /* 38 */ '\t_ = Total(o)',
    /* 39 */ '}',
    /* 40 */ '',
    /* 41 */ 'func helper() Status { return Status(1) }',
  );
  const PROJECT = {
    'go.mod': 'module example.com/shop\n\ngo 1.22\n',
    'internal/pricing/pricing.go': 'package pricing\n\nfunc PriceOf(o any) int { return 1 }\n',
    'internal/pricing/other.go': 'package pricing\n\nfunc (x *T) Missing() {}\n',
    'internal/orders/service.go': 'package orders\n\ntype Service struct{}\n',
    'internal/orders/shared.go': 'package orders\n\nfunc shared(o *Order) {}\n',
  };

  it('reads structs and named types as type, interfaces as interface, receivers as methods of their type', () => {
    const result = readProject(FILE, TEXT, PROJECT);
    expect(result.language).toBe('go');
    expect(kindsOf(result)).toEqual([
      ['Status', 'type'],
      ['Order', 'type'],
      ['Saver', 'interface'],
      ['Total', 'function'],
      ['Service.Pay', 'method'],
      ['Service.record', 'method'],
      ['helper', 'function'],
    ]);
    expect(pieceNamed(result, `${FILE}#Order`).doc).toBe('Order is one purchase.');
    expect(pieceNamed(result, `${FILE}#Service.Pay`).className).toBe('Service');
    // `Service` is declared in another file of the package: no frame here.
    expect(result.classes).toEqual([]);
  });

  it('calls through the receiver, into the package directory and the same package', () => {
    const result = readProject(FILE, TEXT, PROJECT);
    expect(callsFrom(result, 'Total')).toEqual([
      { line: 24, to: null, external: { file: 'internal/pricing/pricing.go', name: 'PriceOf' } },
    ]);
    expect(callsFrom(result, 'Service.Pay')).toEqual([
      { line: 28, to: 'Service.record' },
      // A package with no file on disk, and a name no file of the package declares at its top level: plain.
      { line: 30, to: null, unresolvedName: 'au.Write' },
      { line: 31, to: null, unresolvedName: 'pricing.Missing' },
      { line: 32, to: null, unresolvedName: 'mystery' },
      { line: 33, to: null, external: { file: 'internal/orders/shared.go', name: 'shared' } },
      { line: 34, to: null, unresolvedName: 's.notify' },
    ]);
    expect(callsFrom(result, 'Service.record')).toEqual([{ line: 38, to: 'Total' }]);
    expect(callsFrom(result, 'helper')).toEqual([{ line: 41, to: 'Status' }]);
  });

  it('keeps package calls plain when the project cannot be read', () => {
    const result = readProject(FILE, TEXT, PROJECT, { readable: false });
    // Without go.mod's text the module path is unknown, so `pricing` is a package like `fmt`: dropped.
    expect(callsFrom(result, 'Total')).toEqual([]);
    expect(callsFrom(result, 'Service.Pay')).toContainEqual({ line: 33, to: null, unresolvedName: 'shared' });
  });

  it('reads type uses from fields, parameters and results; exports by capital letter', () => {
    const result = readProject(FILE, TEXT, PROJECT);
    expect(typeUsesOf(result)).toEqual([
      'Order->Status',
      'Saver->Order',
      'Total->Order',
      'Service.Pay->Order',
      'Service.record->Order',
      'helper->Status',
    ]);
    expect(pieceNamed(result, `${FILE}#helper`).exported).toBe(false);
    expect(entriesOf(result)).toEqual(['Total', 'Service.Pay']);
  });

  it('refuses a file that does not parse', () => {
    expectSyntaxError('a/b.go', lines('package b', '', 'func ok() {}', 'func broken( {'), 4);
  });
});

describe('Go: resolveGoImport', () => {
  const project = (files: Record<string, string>) => ({
    fileExists: (path: string) => path in files,
    readFile: (path: string) => files[path] ?? null,
  });

  it('maps a module path to its package directory, from the nearest go.mod', () => {
    const files = project({ 'svc/go.mod': 'module example.com/svc\n' });
    expect(resolveGoImport('svc/cmd/main.go', 'example.com/svc/internal/x', files)).toBe('svc/internal/x/');
    expect(resolveGoImport('svc/cmd/main.go', 'example.com/svc', files)).toBe('svc/');
    expect(resolveGoImport('svc/cmd/main.go', 'example.com/other/x', files)).toBeNull();
    expect(resolveGoImport('svc/cmd/main.go', 'net/http', files)).toBeNull();
  });

  it('resolves nothing without a readable go.mod', () => {
    expect(resolveGoImport('a/main.go', 'example.com/svc/x', { fileExists: () => true })).toBeNull();
  });
});

describe('Rust: impl blocks, traits, self and Self, mod and use crate::', () => {
  const FILE = 'src/orders.rs';
  const TEXT = lines(
    /*  1 */ 'mod pricing;',
    /*  2 */ 'use crate::shared::audit;',
    /*  3 */ 'use crate::shared::rules::{check, Rule as R};',
    /*  4 */ 'use std::collections::HashMap;',
    /*  5 */ '',
    /*  6 */ '/// Where an order is.',
    /*  7 */ 'pub enum Status { Open, Paid }',
    /*  8 */ '',
    /*  9 */ '/// One purchase.',
    /* 10 */ '#[derive(Debug, Clone)]',
    /* 11 */ 'pub struct Order {',
    /* 12 */ '    pub id: String,',
    /* 13 */ '    pub status: Status,',
    /* 14 */ '}',
    /* 15 */ '',
    /* 16 */ 'pub trait Saver {',
    /* 17 */ '    fn save(&self, order: &Order);',
    /* 18 */ '    fn save_all(&self, orders: &[Order]) {',
    /* 19 */ '        for o in orders { self.save(o); }',
    /* 20 */ '    }',
    /* 21 */ '}',
    /* 22 */ '',
    /* 23 */ 'pub struct Service;',
    /* 24 */ '',
    /* 25 */ 'impl Service {',
    /* 26 */ '    /// Builds one.',
    /* 27 */ '    pub fn new() -> Self {',
    /* 28 */ '        Self::make()',
    /* 29 */ '    }',
    /* 30 */ '',
    /* 31 */ '    fn make() -> Service {',
    /* 32 */ '        Service',
    /* 33 */ '    }',
    /* 34 */ '',
    /* 35 */ '    pub fn pay(&self, order: &Order) -> Status {',
    /* 36 */ '        self.record(order);',
    /* 37 */ '        pricing::price_of(order);',
    /* 38 */ '        audit::write(order);',
    /* 39 */ '        check(order);',
    /* 40 */ '        HashMap::new();',
    /* 41 */ '        mystery(order);',
    /* 42 */ '        self.notify(order);',
    /* 43 */ '        Status::Paid',
    /* 44 */ '    }',
    /* 45 */ '',
    /* 46 */ '    fn record(&self, order: &Order) {',
    /* 47 */ '        let _ = total(order);',
    /* 48 */ '    }',
    /* 49 */ '}',
    /* 50 */ '',
    /* 51 */ 'pub fn total(order: &Order) -> u32 {',
    /* 52 */ '    Order::describe(order);',
    /* 53 */ '    Some(1).unwrap()',
    /* 54 */ '}',
    /* 55 */ '',
    /* 56 */ 'fn helper() {}',
  );
  const EXISTING = ['src/lib.rs', 'src/orders/pricing.rs', 'src/shared/audit.rs', 'src/shared/rules.rs'];

  it('draws impl functions as methods of their type and trait methods as the trait’s', () => {
    const result = readOk(FILE, TEXT, EXISTING);
    expect(result.language).toBe('rust');
    expect(kindsOf(result)).toEqual([
      ['Status', 'enum'],
      ['Order', 'type'],
      ['Saver', 'interface'],
      ['Saver.save', 'method'],
      ['Saver.save_all', 'method'],
      ['Service', 'type'],
      ['Service.new', 'method'],
      ['Service.make', 'method'],
      ['Service.pay', 'method'],
      ['Service.record', 'method'],
      ['total', 'function'],
      ['helper', 'function'],
    ]);
    // The doc is read past the `#[derive]` attribute.
    expect(pieceNamed(result, `${FILE}#Order`).doc).toBe('One purchase.');
    expect(pieceNamed(result, `${FILE}#Service.new`).doc).toBe('Builds one.');
    expect(result.classes.map((frame) => frame.name)).toEqual(['Saver', 'Service']);
  });

  it('calls through self and Self, mod and use crate:: paths; drops std, keeps the rest plain', () => {
    const result = readOk(FILE, TEXT, EXISTING);
    expect(callsFrom(result, 'Saver.save_all')).toEqual([{ line: 19, to: 'Saver.save' }]);
    expect(callsFrom(result, 'Service.new')).toEqual([{ line: 28, to: 'Service.make' }]);
    expect(callsFrom(result, 'Service.pay')).toEqual([
      { line: 36, to: 'Service.record' },
      { line: 37, to: null, external: { file: 'src/orders/pricing.rs', name: 'price_of' } },
      { line: 38, to: null, external: { file: 'src/shared/audit.rs', name: 'write' } },
      { line: 39, to: null, external: { file: 'src/shared/rules.rs', name: 'check' } },
      { line: 41, to: null, unresolvedName: 'mystery' },
      { line: 42, to: null, unresolvedName: 'self.notify' },
    ]);
    expect(callsFrom(result, 'Service.record')).toEqual([{ line: 47, to: 'total' }]);
    expect(callsFrom(result, 'total')).toEqual([{ line: 52, to: null, unresolvedName: 'Order::describe' }]);
  });

  it('exports by pub, opens on public functions and methods', () => {
    const result = readOk(FILE, TEXT, EXISTING);
    expect(pieceNamed(result, `${FILE}#helper`).exported).toBe(false);
    expect(entriesOf(result)).toEqual(['Service.new', 'Service.pay', 'total']);
    expect(typeUsesOf(result)).toContain('Order->Status');
    expect(typeUsesOf(result)).toContain('Service.pay->Order');
  });

  it('resolves crate::, self::, super:: and bare module paths', () => {
    const exists = (paths: string[]) => ({ fileExists: (path: string) => paths.includes(path) });
    const project = exists(['src/main.rs', 'src/a/b.rs', 'src/a/c/mod.rs', 'src/a/d.rs', 'src/x.rs']);
    expect(resolveRustImport('src/a/d.rs', 'crate::a::b', project)).toBe('src/a/b.rs');
    expect(resolveRustImport('src/a/mod.rs', 'self::c', project)).toBe('src/a/c/mod.rs');
    expect(resolveRustImport('src/a/b.rs', 'super::d', project)).toBe('src/a/d.rs');
    expect(resolveRustImport('src/main.rs', 'x', project)).toBe('src/x.rs');
    expect(resolveRustImport('src/main.rs', 'std::io', project)).toBeNull();
  });

  it('refuses a file that does not parse', () => {
    expectSyntaxError('src/bad.rs', lines('fn ok() {}', '', 'fn broken( {'), 3);
  });
});

describe('Java: classes, constructors, this, imports and the same package', () => {
  const FILE = 'src/main/java/com/acme/orders/OrderService.java';
  const TEXT = lines(
    /*  1 */ 'package com.acme.orders;',
    /*  2 */ '',
    /*  3 */ 'import com.acme.shared.Audit;',
    /*  4 */ 'import com.acme.shared.Rules;',
    /*  5 */ 'import java.util.List;',
    /*  6 */ 'import java.util.ArrayList;',
    /*  7 */ '',
    /*  8 */ '/**',
    /*  9 */ ' * Takes orders through payment. More detail.',
    /* 10 */ ' * @author someone',
    /* 11 */ ' */',
    /* 12 */ '@Service',
    /* 13 */ 'public class OrderService implements Saver {',
    /* 14 */ '    private final Repo repo;',
    /* 15 */ '',
    /* 16 */ '    public OrderService(Repo repo) {',
    /* 17 */ '        this.repo = repo;',
    /* 18 */ '    }',
    /* 19 */ '',
    /* 20 */ '    // Charges the order.',
    /* 21 */ '    public Order pay(Order order) {',
    /* 22 */ '        this.record(order);',
    /* 23 */ '        record(order);',
    /* 24 */ '        Audit.write(order);',
    /* 25 */ '        Pricing.priceOf(order);',
    /* 26 */ '        new Order("x");',
    /* 27 */ '        new ArrayList<Order>();',
    /* 28 */ '        new StringBuilder();',
    /* 29 */ '        repo.save(order);',
    /* 30 */ '        mystery(order);',
    /* 31 */ '        this.notify(order);',
    /* 32 */ '        return order;',
    /* 33 */ '    }',
    /* 34 */ '',
    /* 35 */ '    void record(Order order) {',
    /* 36 */ '        List<Order> all = new ArrayList<>();',
    /* 37 */ '    }',
    /* 38 */ '',
    /* 39 */ '    public void save(Order order) {}',
    /* 40 */ '}',
    /* 41 */ '',
    /* 42 */ 'interface Saver {',
    /* 43 */ '    void save(Order order);',
    /* 44 */ '}',
    /* 45 */ '',
    /* 46 */ 'enum Status { OPEN, PAID }',
    /* 47 */ '',
    /* 48 */ 'record Order(String id, Status status) {',
    /* 49 */ '    Order {',
    /* 50 */ '        validate(id);',
    /* 51 */ '    }',
    /* 52 */ '}',
  );
  const EXISTING = ['src/main/java/com/acme/shared/Audit.java', 'src/main/java/com/acme/orders/Pricing.java'];

  it('draws classes, interfaces, enums and records, with constructors marked', () => {
    const result = readOk(FILE, TEXT, EXISTING);
    expect(result.language).toBe('java');
    expect(kindsOf(result)).toEqual([
      ['OrderService', 'class'],
      ['OrderService.OrderService', 'method'],
      ['OrderService.pay', 'method'],
      ['OrderService.record', 'method'],
      ['OrderService.save', 'method'],
      ['Saver', 'interface'],
      ['Saver.save', 'method'],
      ['Status', 'enum'],
      ['Order', 'type'],
      ['Order.Order', 'method'],
    ]);
    expect(pieceNamed(result, `${FILE}#OrderService`).doc).toBe('Takes orders through payment.');
    expect(pieceNamed(result, `${FILE}#OrderService`).startLine).toBe(12);
    expect(pieceNamed(result, `${FILE}#OrderService.pay`).doc).toBe('Charges the order.');
    expect(pieceNamed(result, `${FILE}#OrderService.OrderService`).isConstructor).toBe(true);
    expect(result.classes[0]).toMatchObject({ name: 'OrderService', constructorSignature: 'OrderService(Repo repo)' });
  });

  it('calls through this and bare members, imports, the same package, and new', () => {
    const result = readOk(FILE, TEXT, EXISTING);
    expect(callsFrom(result, 'OrderService.pay')).toEqual([
      { line: 22, to: 'OrderService.record' },
      { line: 23, to: 'OrderService.record' },
      { line: 24, to: null, external: { file: 'src/main/java/com/acme/shared/Audit.java', name: 'write' } },
      { line: 25, to: null, external: { file: 'src/main/java/com/acme/orders/Pricing.java', name: 'priceOf' } },
      { line: 26, to: 'Order.Order' },
      { line: 30, to: null, unresolvedName: 'mystery' },
      { line: 31, to: null, unresolvedName: 'this.notify' },
    ]);
  });

  it('exports by public; interface members are public; type uses include headers', () => {
    const result = readOk(FILE, TEXT, EXISTING);
    expect(pieceNamed(result, `${FILE}#Saver`).exported).toBe(false);
    expect(entriesOf(result)).toEqual(['OrderService', 'OrderService.pay', 'OrderService.save']);
    expect(typeUsesOf(result)).toEqual([
      'OrderService->Saver',
      'OrderService.pay->Order',
      'OrderService.record->Order',
      'OrderService.save->Order',
      'Saver.save->Order',
      'Order->Status',
    ]);
  });

  it('resolves an import from any ancestor source root', () => {
    const project = { fileExists: (path: string) => path === 'app/src/com/a/B.java' };
    expect(resolveJavaImport('app/src/com/x/Y.java', 'com.a.B', project)).toBe('app/src/com/a/B.java');
    expect(resolveJavaImport('app/src/com/x/Y.java', 'java.util.List', project)).toBeNull();
  });

  it('refuses a file that does not parse', () => {
    expectSyntaxError('A.java', lines('class A {', '  void f( {', '}'), 2);
  });
});

describe('C#: classes, records, this, and the one-type-per-file convention', () => {
  const FILE = 'src/Orders/OrderService.cs';
  const TEXT = lines(
    /*  1 */ 'using System;',
    /*  2 */ 'using Acme.Shared;',
    /*  3 */ '',
    /*  4 */ 'namespace Acme.Orders;',
    /*  5 */ '',
    /*  6 */ '/// <summary>Takes orders through payment.</summary>',
    /*  7 */ '[Serializable]',
    /*  8 */ 'public class OrderService : ISaver',
    /*  9 */ '{',
    /* 10 */ '    private readonly Repo _repo;',
    /* 11 */ '',
    /* 12 */ '    public OrderService(Repo repo) { _repo = repo; }',
    /* 13 */ '',
    /* 14 */ '    /// <summary>',
    /* 15 */ '    /// Charges the order. Then more.',
    /* 16 */ '    /// </summary>',
    /* 17 */ '    public Order Pay(Order order)',
    /* 18 */ '    {',
    /* 19 */ '        this.Record(order);',
    /* 20 */ '        Record(order);',
    /* 21 */ '        Pricing.PriceOf(order);',
    /* 22 */ '        Console.WriteLine("paid");',
    /* 23 */ '        var o = new Order("x");',
    /* 24 */ '        Mystery(order);',
    /* 25 */ '        this.Notify(order);',
    /* 26 */ '        return order;',
    /* 27 */ '    }',
    /* 28 */ '',
    /* 29 */ '    private void Record(Order order) => Helpers.Log(order);',
    /* 30 */ '',
    /* 31 */ '    public void Save(Order order) { }',
    /* 32 */ '}',
    /* 33 */ '',
    /* 34 */ 'public interface ISaver { void Save(Order order); }',
    /* 35 */ '',
    /* 36 */ 'public struct Point { public int X; }',
    /* 37 */ '',
    /* 38 */ 'public enum Status { Open, Paid }',
    /* 39 */ '',
    /* 40 */ 'public record Order(string Id, Status Status);',
  );

  it('draws classes, interfaces, structs, enums and records; docs drop their XML', () => {
    const result = readOk(FILE, TEXT, ['src/Orders/Pricing.cs']);
    expect(result.language).toBe('csharp');
    expect(kindsOf(result)).toEqual([
      ['OrderService', 'class'],
      ['OrderService.OrderService', 'method'],
      ['OrderService.Pay', 'method'],
      ['OrderService.Record', 'method'],
      ['OrderService.Save', 'method'],
      ['ISaver', 'interface'],
      ['ISaver.Save', 'method'],
      ['Point', 'type'],
      ['Status', 'enum'],
      ['Order', 'type'],
    ]);
    expect(pieceNamed(result, `${FILE}#OrderService`).doc).toBe('Takes orders through payment.');
    expect(pieceNamed(result, `${FILE}#OrderService.Pay`).doc).toBe('Charges the order.');
  });

  it('calls through this, bare members, a sibling type file, and new; namespaces resolve nothing', () => {
    const result = readOk(FILE, TEXT, ['src/Orders/Pricing.cs']);
    expect(callsFrom(result, 'OrderService.Pay')).toEqual([
      { line: 19, to: 'OrderService.Record' },
      { line: 20, to: 'OrderService.Record' },
      { line: 21, to: null, external: { file: 'src/Orders/Pricing.cs', name: 'PriceOf' } },
      { line: 23, to: 'Order' },
      { line: 24, to: null, unresolvedName: 'Mystery' },
      { line: 25, to: null, unresolvedName: 'this.Notify' },
    ]);
    // `Helpers` names no file: dropped, like a package.
    expect(callsFrom(result, 'OrderService.Record')).toEqual([]);
  });

  it('exports by public and opens on public methods', () => {
    const result = readOk(FILE, TEXT, []);
    expect(entriesOf(result)).toEqual(['OrderService', 'OrderService.Pay', 'OrderService.Save']);
    expect(typeUsesOf(result)).toContain('OrderService->ISaver');
    expect(typeUsesOf(result)).toContain('Order->Status');
  });

  it('refuses a file that does not parse', () => {
    expectSyntaxError('A.cs', lines('class A {', '  void F( {', '}'), 2);
  });
});

describe('Ruby: classes, modules, self, implicit self, private and require_relative', () => {
  const FILE = 'lib/orders/service.rb';
  const TEXT = lines(
    /*  1 */ "require_relative 'pricing'",
    /*  2 */ "require_relative './audit.rb'",
    /*  3 */ "require 'json'",
    /*  4 */ '',
    /*  5 */ '# Takes orders through payment.',
    /*  6 */ '# More detail.',
    /*  7 */ 'class OrderService',
    /*  8 */ '  def initialize(repo)',
    /*  9 */ '    @repo = repo',
    /* 10 */ '  end',
    /* 11 */ '',
    /* 12 */ '  # Charges the order.',
    /* 13 */ '  def pay(order)',
    /* 14 */ '    self.record(order)',
    /* 15 */ '    record(order)',
    /* 16 */ '    Pricing.price_of(order)',
    /* 17 */ '    Audit.write(order)',
    /* 18 */ '    OrderService.build',
    /* 19 */ '    Order.new(order)',
    /* 20 */ '    puts "paid"',
    /* 21 */ '    mystery(order)',
    /* 22 */ '    self.notify(order)',
    /* 23 */ '  end',
    /* 24 */ '',
    /* 25 */ '  def self.build',
    /* 26 */ '    new(nil)',
    /* 27 */ '  end',
    /* 28 */ '',
    /* 29 */ '  private',
    /* 30 */ '',
    /* 31 */ '  def record(order)',
    /* 32 */ '    helper(order)',
    /* 33 */ '  end',
    /* 34 */ 'end',
    /* 35 */ '',
    /* 36 */ 'class Order',
    /* 37 */ '  def initialize(id); @id = id; end',
    /* 38 */ 'end',
    /* 39 */ '',
    /* 40 */ 'module Util',
    /* 41 */ '  def self.slug(text) = text.downcase',
    /* 42 */ 'end',
    /* 43 */ '',
    /* 44 */ 'def helper(x)',
    /* 45 */ '  Util.slug(x)',
    /* 46 */ 'end',
  );
  const PROJECT = {
    'lib/orders/pricing.rb': '# Prices.\nmodule Pricing\n  def self.price_of(o) = 1\nend\n',
    'lib/orders/audit.rb': '',
  };

  it('draws classes and modules with their methods, initialize as the constructor', () => {
    const result = readProject(FILE, TEXT, PROJECT);
    expect(result.language).toBe('ruby');
    expect(kindsOf(result)).toEqual([
      ['OrderService', 'class'],
      ['OrderService.initialize', 'method'],
      ['OrderService.pay', 'method'],
      ['OrderService.build', 'method'],
      ['OrderService.record', 'method'],
      ['Order', 'class'],
      ['Order.initialize', 'method'],
      ['Util', 'class'],
      ['Util.slug', 'method'],
      ['helper', 'function'],
    ]);
    expect(pieceNamed(result, `${FILE}#OrderService`).doc).toBe('Takes orders through payment.');
    expect(result.classes[0]).toMatchObject({ name: 'OrderService', constructorSignature: 'initialize(repo)' });
  });

  it('calls through self and implicit self, Klass.new, and constants from a required file', () => {
    const result = readProject(FILE, TEXT, PROJECT);
    expect(callsFrom(result, 'OrderService.pay')).toEqual([
      { line: 14, to: 'OrderService.record' },
      { line: 15, to: 'OrderService.record' },
      { line: 16, to: null, external: { file: 'lib/orders/pricing.rb', name: 'price_of' } },
      { line: 18, to: 'OrderService.build' },
      { line: 19, to: 'Order.initialize' },
      { line: 21, to: null, unresolvedName: 'mystery' },
      { line: 22, to: null, unresolvedName: 'self.notify' },
    ]);
    expect(callsFrom(result, 'OrderService.record')).toEqual([{ line: 32, to: 'helper' }]);
    expect(callsFrom(result, 'helper')).toEqual([{ line: 45, to: 'Util.slug' }]);
  });

  it('drops a required constant when the project cannot be read', () => {
    const result = readProject(FILE, TEXT, PROJECT, { readable: false });
    expect(callsFrom(result, 'OrderService.pay').map((call) => call.line)).not.toContain(16);
  });

  it('a bare private section hides the methods below it from the entries', () => {
    const result = readProject(FILE, TEXT, PROJECT);
    expect(entriesOf(result)).toEqual([
      'OrderService',
      'OrderService.pay',
      'OrderService.build',
      'Order',
      'Util',
      'Util.slug',
      'helper',
    ]);
  });

  it('refuses a file that does not parse', () => {
    expectSyntaxError('a.rb', lines('def ok', 'end', 'def broken(', ''), 3);
  });
});

describe('PHP: classes, $this, self::, use through PSR-4 and require', () => {
  const FILE = 'src/Orders/OrderService.php';
  const TEXT = lines(
    /*  1 */ '<?php',
    /*  2 */ 'namespace App\\Orders;',
    /*  3 */ '',
    /*  4 */ 'use App\\Shared\\Audit;',
    /*  5 */ 'use App\\Models\\Order as O;',
    /*  6 */ 'use Vendor\\Lib\\Thing;',
    /*  7 */ '',
    /*  8 */ "require_once __DIR__ . '/helpers.php';",
    /*  9 */ '',
    /* 10 */ '/**',
    /* 11 */ ' * Takes orders through payment.',
    /* 12 */ ' */',
    /* 13 */ 'class OrderService implements Saver',
    /* 14 */ '{',
    /* 15 */ '    public function __construct(private Repo $repo) {}',
    /* 16 */ '',
    /* 17 */ '    /** Charges the order. */',
    /* 18 */ '    public function pay(O $order): Status',
    /* 19 */ '    {',
    /* 20 */ '        $this->record($order);',
    /* 21 */ '        self::make();',
    /* 22 */ '        static::make();',
    /* 23 */ '        Audit::write($order);',
    /* 24 */ '        Thing::go();',
    /* 25 */ '        new O();',
    /* 26 */ '        new OrderService($this->repo);',
    /* 27 */ '        format_money(1);',
    /* 28 */ '        strlen("x");',
    /* 29 */ '        mystery($order);',
    /* 30 */ '        $this->notify($order);',
    /* 31 */ '        return Status::Paid;',
    /* 32 */ '    }',
    /* 33 */ '',
    /* 34 */ '    private function record(O $order): void {}',
    /* 35 */ '',
    /* 36 */ '    public static function make(): self { return new self(); }',
    /* 37 */ '}',
    /* 38 */ '',
    /* 39 */ 'interface Saver { public function save(O $order); }',
    /* 40 */ '',
    /* 41 */ 'enum Status { case Open; case Paid; }',
    /* 42 */ '',
    /* 43 */ 'function helper(Status $s): int { return 1; }',
  );
  const PROJECT = {
    'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } } }),
    'src/Shared/Audit.php': '',
    'src/Models/Order.php': '',
    'src/Orders/helpers.php': '<?php\nfunction format_money($x) { return $x; }\n',
  };

  it('draws classes, interfaces, enums, functions and methods', () => {
    const result = readProject(FILE, TEXT, PROJECT);
    expect(result.language).toBe('php');
    expect(kindsOf(result)).toEqual([
      ['OrderService', 'class'],
      ['OrderService.__construct', 'method'],
      ['OrderService.pay', 'method'],
      ['OrderService.record', 'method'],
      ['OrderService.make', 'method'],
      ['Saver', 'interface'],
      ['Saver.save', 'method'],
      ['Status', 'enum'],
      ['helper', 'function'],
    ]);
    expect(pieceNamed(result, `${FILE}#OrderService`).doc).toBe('Takes orders through payment.');
    expect(pieceNamed(result, `${FILE}#OrderService.pay`).doc).toBe('Charges the order.');
  });

  it('calls through $this, self::, static::, a PSR-4 use, a required file and new', () => {
    const result = readProject(FILE, TEXT, PROJECT);
    expect(callsFrom(result, 'OrderService.pay')).toEqual([
      { line: 20, to: 'OrderService.record' },
      { line: 21, to: 'OrderService.make' },
      { line: 22, to: 'OrderService.make' },
      { line: 23, to: null, external: { file: 'src/Shared/Audit.php', name: 'write' } },
      { line: 25, to: null, external: { file: 'src/Models/Order.php', name: 'Order' } },
      { line: 26, to: 'OrderService.__construct' },
      { line: 27, to: null, external: { file: 'src/Orders/helpers.php', name: 'format_money' } },
      { line: 29, to: null, unresolvedName: 'mystery' },
      { line: 30, to: null, unresolvedName: '$this->notify' },
    ]);
    expect(callsFrom(result, 'OrderService.make')).toEqual([{ line: 36, to: 'OrderService.__construct' }]);
  });

  it('hides private methods from the entries', () => {
    const result = readProject(FILE, TEXT, PROJECT);
    expect(entriesOf(result)).toEqual(['OrderService', 'OrderService.pay', 'OrderService.make', 'helper']);
    expect(typeUsesOf(result)).toEqual(['OrderService->Saver', 'OrderService.pay->Status', 'helper->Status']);
  });

  it('resolves use through composer.json, then the usual layouts; require relative to the file', () => {
    const files: Record<string, string> = {
      'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'Acme\\': 'lib/' } } }),
      'lib/Billing/Invoice.php': '',
      'app/Models/User.php': '',
      'src/inc/a.php': '',
    };
    const project = { fileExists: (path: string) => path in files, readFile: (path: string) => files[path] ?? null };
    expect(resolvePhpImport('src/x.php', 'Acme\\Billing\\Invoice', project)).toBe('lib/Billing/Invoice.php');
    expect(resolvePhpImport('src/x.php', 'App\\Models\\User', project)).toBe('app/Models/User.php');
    expect(resolvePhpImport('src/x.php', 'Vendor\\Thing', project)).toBeNull();
    expect(resolvePhpImport('src/x.php', '/inc/a.php', project)).toBe('src/inc/a.php');
  });

  it('refuses a file that does not parse', () => {
    expectSyntaxError('a.php', lines('<?php', 'function ok() {}', 'function broken( {'), 3);
  });
});

describe('C/C++: classes, out-of-line methods, this->, includes', () => {
  const FILE = 'src/service.cpp';
  const TEXT = lines(
    /*  1 */ '#include "pricing.h"',
    /*  2 */ '#include "missing.h"',
    /*  3 */ '#include <vector>',
    /*  4 */ '',
    /*  5 */ '/// Where an order is.',
    /*  6 */ 'enum Status { Open, Paid };',
    /*  7 */ '',
    /*  8 */ '/** One purchase. */',
    /*  9 */ 'struct Order {',
    /* 10 */ '  int id;',
    /* 11 */ '  Status status;',
    /* 12 */ '};',
    /* 13 */ '',
    /* 14 */ 'class Service : public Saver {',
    /* 15 */ 'public:',
    /* 16 */ '  Service(int retries) : retries_(retries) {}',
    /* 17 */ '  /// Charges the order.',
    /* 18 */ '  Status pay(Order& order) {',
    /* 19 */ '    this->record(order);',
    /* 20 */ '    record(order);',
    /* 21 */ '    price_of(order);',
    /* 22 */ '    Service::make();',
    /* 23 */ '    printf("paid");',
    /* 24 */ '    mystery(order);',
    /* 25 */ '    this->notify(order);',
    /* 26 */ '    return Paid;',
    /* 27 */ '  }',
    /* 28 */ '  static Service make();',
    /* 29 */ 'private:',
    /* 30 */ '  void record(const Order& order) {}',
    /* 31 */ '  int retries_;',
    /* 32 */ '};',
    /* 33 */ '',
    /* 34 */ '// Builds the default service.',
    /* 35 */ 'Service Service::make() { return Service(1); }',
    /* 36 */ '',
    /* 37 */ 'static int helper(Order* o) { return total(o); }',
    /* 38 */ '',
    /* 39 */ 'int *total(Order* o) { return nullptr; }',
  );
  const PROJECT = { 'src/pricing.h': '#pragma once\nint price_of(const Order& o);\n', 'src/missing.h': '' };

  it('draws enums and structs as data structures, in-class and out-of-line methods', () => {
    const result = readProject(FILE, TEXT, PROJECT);
    expect(result.language).toBe('cpp');
    expect(kindsOf(result)).toEqual([
      ['Status', 'enum'],
      ['Order', 'type'],
      ['Service', 'class'],
      ['Service.Service', 'method'],
      ['Service.pay', 'method'],
      ['Service.record', 'method'],
      ['Service.make', 'method'],
      ['helper', 'function'],
      ['total', 'function'],
    ]);
    expect(pieceNamed(result, `${FILE}#Order`).doc).toBe('One purchase.');
    expect(pieceNamed(result, `${FILE}#Service.make`).doc).toBe('Builds the default service.');
    expect(result.classes).toEqual([
      { name: 'Service', file: FILE, startLine: 14, constructorSignature: 'Service(int retries)' },
    ]);
  });

  it('calls through this->, bare members, A::m(), a header prototype and a constructor', () => {
    const result = readProject(FILE, TEXT, PROJECT);
    expect(callsFrom(result, 'Service.pay')).toEqual([
      { line: 19, to: 'Service.record' },
      { line: 20, to: 'Service.record' },
      { line: 21, to: null, external: { file: 'src/pricing.h', name: 'price_of' } },
      { line: 22, to: 'Service.make' },
      { line: 24, to: null, unresolvedName: 'mystery' },
      { line: 25, to: null, unresolvedName: 'this->notify' },
    ]);
    expect(callsFrom(result, 'Service.make')).toEqual([{ line: 35, to: 'Service.Service' }]);
    expect(callsFrom(result, 'helper')).toEqual([{ line: 37, to: 'total' }]);
  });

  it('keeps a header’s function plain when the project cannot be read', () => {
    const result = readProject(FILE, TEXT, PROJECT, { readable: false });
    expect(callsFrom(result, 'Service.pay')).toContainEqual({ line: 21, to: null, unresolvedName: 'price_of' });
  });

  it('follows access sections and static linkage for the entries', () => {
    const result = readProject(FILE, TEXT, PROJECT);
    expect(pieceNamed(result, `${FILE}#helper`).exported).toBe(false);
    expect(entriesOf(result)).toEqual(['Service', 'Service.pay', 'Service.make', 'total']);
    expect(typeUsesOf(result)).toContain('Order->Status');
    expect(typeUsesOf(result)).toContain('Service.pay->Order');
  });

  it('resolves an include beside the file, then under an ancestor’s include/', () => {
    const project = { fileExists: (path: string) => ['src/a.h', 'include/b.h'].includes(path) };
    expect(resolveCppInclude('src/x.cpp', 'a.h', project)).toBe('src/a.h');
    expect(resolveCppInclude('src/x.cpp', 'b.h', project)).toBe('include/b.h');
    expect(resolveCppInclude('src/x.cpp', 'c.h', project)).toBeNull();
  });

  it('refuses a file that does not parse', () => {
    expectSyntaxError('a.c', lines('int ok(void) { return 0; }', 'int broken( {'), 2);
  });
});

describe('Bash: functions, commands and source', () => {
  const FILE = 'scripts/deploy.sh';
  const TEXT = lines(
    /*  1 */ '#!/usr/bin/env bash',
    /*  2 */ 'set -euo pipefail',
    /*  3 */ 'source ./lib/log.sh',
    /*  4 */ '. "$HOME/.profile"',
    /*  5 */ '',
    /*  6 */ '# Deploys the app. Then waits.',
    /*  7 */ 'deploy() {',
    /*  8 */ '  build "$1"',
    /*  9 */ '  log_info "deploying"',
    /* 10 */ '  git push origin main',
    /* 11 */ '  mystery_tool --flag',
    /* 12 */ '}',
    /* 13 */ '',
    /* 14 */ 'function build {',
    /* 15 */ '  echo "building $1"',
    /* 16 */ '  helper',
    /* 17 */ '}',
    /* 18 */ '',
    /* 19 */ 'helper() { :; }',
    /* 20 */ '',
    /* 21 */ 'deploy "$@"',
  );
  const PROJECT = { 'scripts/lib/log.sh': 'log_info() { echo "$@"; }\n' };

  it('draws both function forms and their calls; a sourced function resolves; programs are dropped', () => {
    const result = readProject(FILE, TEXT, PROJECT);
    expect(result.language).toBe('bash');
    expect(kindsOf(result)).toEqual([
      ['deploy', 'function'],
      ['build', 'function'],
      ['helper', 'function'],
    ]);
    expect(pieceNamed(result, `${FILE}#deploy`).doc).toBe('Deploys the app.');
    expect(callsFrom(result, 'deploy')).toEqual([
      { line: 8, to: 'build' },
      { line: 9, to: null, external: { file: 'scripts/lib/log.sh', name: 'log_info' } },
    ]);
    expect(callsFrom(result, 'build')).toEqual([{ line: 16, to: 'helper' }]);
    expect(entriesOf(result)).toEqual(['deploy', 'build', 'helper']);
  });

  it('refuses a file that does not parse', () => {
    expectSyntaxError('a.sh', lines('ok() { :; }', 'broken() {', '  if then', '}'), 2);
  });
});

describe('docCommentAbove', () => {
  const rules = { lineMarkers: ['///', '//'], block: true, skipLine: /^@\w+$/ };

  it('reads a block comment, stopping at doc tags, and line comments past skipped lines', () => {
    const block = ['/**', ' * Does a thing. And more.', ' * @param x the x', ' */', '@Override', 'void f() {}'];
    expect(docCommentAbove(block, 5, rules)).toBe('Does a thing.');
    expect(docCommentAbove(['/// Line one', '/// still one.', 'fn f() {}'], 2, rules)).toBe('Line one still one.');
    expect(docCommentAbove(['/* not closed', 'x', 'f()'], 2, rules)).toBeNull();
    expect(docCommentAbove(['code();', 'f()'], 1, rules)).toBeNull();
  });
});

// ── (d) refusals and the registry ──

describe('refusals', () => {
  it('names the first line that does not parse', () => {
    const text = lines('def ok():', '    return 1', '', 'def broken(:', '    pass');
    const answer = read('app/bad.py', text);
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.reason).toBe('syntax-error');
    expect(answer.sentence).toMatch(/^This file can't be read as a story yet: line 4 doesn't parse \(.+\)\.$/);
    expect(answer.text).toBe(text);
    expect(answer.file).toBe('app/bad.py');
  });

  it('refuses a file no table covers, with its text for the plain view', () => {
    const answer = read('notes/readme.xyz', 'hello');
    expect(answer).toMatchObject({ ok: false, reason: 'unsupported-language', text: 'hello', file: 'notes/readme.xyz' });
  });

  it('says so when the grammar was never loaded', async () => {
    const runtime = loadTreeSitter();
    if (runtime === null) throw new Error('runtime expected');
    const { TreeSitterEngine: Engine } = await import('./storyline-treesitter.js');
    const cold = new Engine(runtime);
    const answer = extractWithTreeSitter({ engine: cold, file: 'a.py', text: 'x = 1', fileExists: () => false });
    expect(answer).toMatchObject({ ok: false, reason: 'no-compiler' });
    if (!answer.ok) expect(answer.sentence).toContain('Python');
  });

  it('maps extensions to tables', () => {
    expect(storylineTableFor('a/b.py')).toBe(PYTHON);
    expect(storylineTableFor('a/b.PYI')).toBe(PYTHON);
    expect(storylineTableFor('a/b.ts')).toBeNull();
    expect(storylineTableFor('a/b.go')).toBe(GO);
    expect(storylineTableFor('a/b.rs')).toBe(RUST);
    expect(storylineTableFor('a/B.java')).toBe(JAVA);
    expect(storylineTableFor('a/B.cs')).toBe(CSHARP);
    expect(storylineTableFor('a/b.rb')).toBe(RUBY);
    expect(storylineTableFor('a/b.php')).toBe(PHP);
    for (const extension of ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh']) {
      expect(storylineTableFor(`a/b${extension}`)).toBe(CPP);
    }
    expect(storylineTableFor('a/b.sh')).toBe(BASH);
  });
});

describe('non-ASCII text keeps lines and text exact', () => {
  it('reads pieces after multi-byte characters', () => {
    const text = lines('# café ☕ — ünïcode', 'def café():', '    """Brews ☕."""', '    return brew()', '', 'def brew():', '    return "é"');
    const result = readOk('app/cafe.py', text);
    expect(result.pieces.map((piece) => [piece.name, piece.startLine, piece.endLine])).toEqual([
      ['café', 2, 4],
      ['brew', 6, 7],
    ]);
    expect(pieceNamed(result, 'app/cafe.py#brew').text).toBe('def brew():\n    return "é"');
    expect(pieceNamed(result, 'app/cafe.py#café').doc).toBe('Brews ☕.');
    expect(result.calls).toEqual([{ from: 'app/cafe.py#café', line: 4, to: 'app/cafe.py#brew' }]);
  });
});

// ── (e) the loader ──

describe('loadTreeSitter', () => {
  const packageDir = join(process.cwd(), 'node_modules', '@vscode', 'tree-sitter-wasm');

  it('prefers the path the app passes', () => {
    const runtime = loadTreeSitter({ env: { [TREESITTER_PATH_ENV]: packageDir } });
    expect(runtime?.wasmDir).toBe(join(packageDir, 'wasm'));
  });

  it('falls back to its own install when the passed path is stale', () => {
    const runtime = loadTreeSitter({ env: { [TREESITTER_PATH_ENV]: '/nowhere/at/all' } });
    expect(runtime).not.toBeNull();
  });

  it('answers null, never throws, when nothing resolves', () => {
    const requireFn = Object.assign(
      (): unknown => {
        throw new Error('not installed');
      },
      {
        resolve: (): string => {
          throw new Error('not installed');
        },
      },
    );
    expect(loadTreeSitter({ env: {}, requireFn })).toBeNull();
  });

  it('starts the runtime once and caches grammars', async () => {
    const runtime = loadTreeSitter();
    if (runtime === null) throw new Error('runtime expected');
    const first = await openTreeSitter(runtime);
    expect(await openTreeSitter(runtime)).toBe(first);
    expect(await first?.grammar('python')).toBe(await first?.grammar('python'));
    expect(await first?.grammar('no-such-language')).toBeNull();
  });
});
