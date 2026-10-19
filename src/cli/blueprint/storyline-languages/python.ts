/**
 * CODE STORYLINE — Python's table (plan `story-any-language` phase 1): docstrings,
 * decorators, dataclasses/Enum/Protocol as data structures, relative and
 * absolute imports, `__all__`.
 */

import { posix } from 'node:path';
import { firstSentence } from '../storyline.js';
import type { TreeSitterNode } from '../storyline-treesitter.js';
import {
  ancestorDirectories,
  firstExisting,
  lineCommentBlockAbove,
  quoted,
  type DefinitionKind,
  type StorylineLanguage,
} from './contract.js';

// ── Python ───────────────────────────────────────────────

/** The base classes that make a Python class a data structure, by the kind it reads as. */
const PYTHON_ENUM_BASES = ['Enum', 'IntEnum', 'StrEnum', 'Flag', 'IntFlag'];
const PYTHON_INTERFACE_BASES = ['Protocol', 'ABC'];
const PYTHON_TYPE_BASES = ['TypedDict', 'NamedTuple', 'BaseModel'];
const PYTHON_TYPE_DECORATORS = ['dataclass'];

/**
 * The alternatives matching a base or decorator name, plain or qualified
 * (`enum.Enum`), bound to `@capture` — to be spliced into ONE `[…]`: a nested
 * alternation silently matches nothing in this runtime.
 */
function pythonNameAlternatives(capture: string): string {
  return `(identifier) @${capture} (attribute attribute: (identifier) @${capture})`;
}


/** A class whose bases include one of `bases` reads as `kind`. */
function pythonBasePattern(kind: DefinitionKind, bases: readonly string[]): string {
  const base = pythonNameAlternatives('_base');
  return `(class_definition
  name: (identifier) @name
  superclasses: (argument_list [${base} (subscript value: (identifier) @_base) (subscript value: (attribute attribute: (identifier) @_base))])
  (#any-of? @_base ${quoted(bases)})) @definition.${kind}`;
}

const PYTHON_DEFINITIONS = `
(function_definition
  name: (identifier) @name
  parameters: (parameters) @parameters
  body: (block) @body) @definition.function
(decorated_definition definition: (function_definition name: (identifier) @name)) @definition.function
(class_definition name: (identifier) @name body: (block) @body) @definition.class
(decorated_definition definition: (class_definition name: (identifier) @name)) @definition.class
(decorated_definition
  (decorator [${pythonNameAlternatives('_decorator')} (call function: (identifier) @_decorator) (call function: (attribute attribute: (identifier) @_decorator))])
  definition: (class_definition name: (identifier) @name)
  (#any-of? @_decorator ${quoted(PYTHON_TYPE_DECORATORS)})) @definition.type
${pythonBasePattern('enum', PYTHON_ENUM_BASES)}
${pythonBasePattern('interface', PYTHON_INTERFACE_BASES)}
${pythonBasePattern('type', PYTHON_TYPE_BASES)}
`;

const PYTHON_CALLS = `
(call function: (identifier) @callee) @call
(call function: (attribute object: (identifier) @receiver attribute: (identifier) @member)) @call
`;

const PYTHON_MODULE_NAME = '[(dotted_name) (relative_import)] @import.source';

const PYTHON_IMPORTS = `
(import_from_statement module_name: ${PYTHON_MODULE_NAME} name: (dotted_name) @import.name)
(import_from_statement
  module_name: ${PYTHON_MODULE_NAME}
  name: (aliased_import name: (dotted_name) @import.name alias: (identifier) @import.alias))
(import_statement name: (dotted_name) @import.source)
(import_statement name: (aliased_import name: (dotted_name) @import.source alias: (identifier) @import.alias))
`;

const PYTHON_TYPE_USES = `
(type) @type
(class_definition superclasses: (argument_list) @type)
`;

const PYTHON_EXPORTS = `
(module (expression_statement (assignment
  left: (identifier) @_all
  right: [(list (string (string_content) @export.name)) (tuple (string (string_content) @export.name))])
  (#eq? @_all "__all__")))
`;

const PYTHON_BUILT_INS: ReadonlySet<string> = new Set([
  'abs', 'all', 'any', 'ascii', 'bin', 'bool', 'breakpoint', 'bytearray', 'bytes', 'callable', 'chr',
  'classmethod', 'compile', 'complex', 'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec',
  'filter', 'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash', 'help', 'hex', 'id',
  'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'locals', 'map', 'max', 'memoryview',
  'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed',
  'round', 'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type',
  'vars', 'zip', '__import__',
  'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'RuntimeError', 'NotImplementedError',
  'AttributeError', 'LookupError', 'OSError', 'StopIteration', 'AssertionError',
]);

const PYTHON_SOURCE_EXTENSION = '.py';
const PYTHON_PACKAGE_INIT = '__init__.py';

/** `pkg.mod` under `base` → `base/pkg/mod.py`, then `base/pkg/mod/__init__.py`. */
function pythonModuleCandidates(base: string, dottedPath: string): string[] {
  if (dottedPath === '') return [posix.join(base, PYTHON_PACKAGE_INIT)];
  const path = dottedPath.split('.').join('/');
  return [posix.join(base, `${path}${PYTHON_SOURCE_EXTENSION}`), posix.join(base, path, PYTHON_PACKAGE_INIT)];
}

/**
 * Python's import rules against the project: a relative specifier (`.x`,
 * `..pkg.mod`) from the file's own package, one dot per level; an absolute one
 * (`pkg.mod`) only when it names a project file under the project root or one
 * of the file's ancestor directories (a `src/` layout) — anything else is a
 * package and resolves to nothing.
 */
export function resolvePythonImport(
  fromFile: string,
  specifier: string,
  fileExists: (relPath: string) => boolean,
): string | null {
  const dots = /^\.*/.exec(specifier)?.[0].length ?? 0;
  const dottedPath = specifier.slice(dots);
  if (dots === 0) {
    if (dottedPath === '') return null;
    for (const root of ancestorDirectories(fromFile)) {
      const found = firstExisting(pythonModuleCandidates(root, dottedPath), fileExists);
      if (found !== null) return found;
    }
    return null;
  }
  let base = posix.dirname(fromFile);
  for (let level = 1; level < dots; level += 1) {
    if (base === '.') return null;
    base = posix.dirname(base);
  }
  return firstExisting(pythonModuleCandidates(base, dottedPath), fileExists);
}

/** A docstring: the first statement of the body, when it is a string. */
function pythonDocstring(body: TreeSitterNode | null): string | null {
  const first = body?.firstNamedChild ?? null;
  if (first === null || first.type !== 'expression_statement') return null;
  const value = first.firstNamedChild;
  if (value === null || value.type !== 'string') return null;
  const content = value.namedChildren
    .filter((child): child is TreeSitterNode => child !== null && child.type === 'string_content')
    .map((child) => child.text)
    .join('');
  return firstSentence(content);
}

const PYTHON_COMMENT_MARKER = '#';
const PYTHON_CONSTRUCTOR = '__init__';

export const PYTHON: StorylineLanguage = {
  id: 'python',
  displayName: 'Python',
  extensions: ['.py', '.pyi'],
  grammar: 'python',
  queries: {
    definitions: PYTHON_DEFINITIONS,
    calls: PYTHON_CALLS,
    imports: PYTHON_IMPORTS,
    typeUses: PYTHON_TYPE_USES,
    exports: PYTHON_EXPORTS,
  },
  // `string_content`: a quoted forward reference (`x: "Row"`) names the type when it is exactly its name.
  typeIdentifierTypes: ['identifier', 'string_content'],
  selfReceivers: ['self', 'cls'],
  isConstructor: (member) => member === PYTHON_CONSTRUCTOR,
  classCallConstructs: true,
  builtIns: PYTHON_BUILT_INS,
  resolveImport: (fromFile, specifier, project) => resolvePythonImport(fromFile, specifier, project.fileExists),
  isLocalSpecifier: (specifier) => specifier.startsWith('.'),
  submoduleSpecifier: (source, name) => (source.endsWith('.') ? `${source}${name}` : `${source}.${name}`),
  isExportedName: (name) => !name.startsWith('_'),
  isPublicMember: (name) => !name.startsWith('_'),
  docOf: ({ span, body, lines }) =>
    pythonDocstring(body) ?? lineCommentBlockAbove(lines, span.startPosition.row, PYTHON_COMMENT_MARKER),
};

