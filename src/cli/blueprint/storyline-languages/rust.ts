/**
 * CODE STORYLINE — Rust's table (plan `story-any-language` phase 2).
 *
 * `fn` items; functions in an `impl Type` block are methods of `Type`
 * (`@owner` — the type may be declared in another file), trait default methods
 * are methods of the trait; `struct`/`type` read as `type`, `enum` as `enum`,
 * `trait` as `interface`. `self.m()` and `Self::f()` call the type's own
 * members, `Type::f()` one of the file's types. `mod x;` and `use
 * crate::…`/`self::…`/`super::…` resolve to `x.rs` or `x/mod.rs` from the
 * crate root (the directory holding `lib.rs`/`main.rs`) or the module's own
 * directory. Exported = `pub`; docs are `///` (or `/** *\/`) above, past any
 * `#[attribute]`.
 */

import { posix } from 'node:path';
import {
  ancestorDirectories,
  docCommentAbove,
  firstExisting,
  hasChildMatching,
  type StorylineLanguage,
  type StorylineProject,
} from './contract.js';

const RUST_DEFINITIONS = `
(function_item
  name: (identifier) @name
  parameters: (parameters) @parameters
  body: (block) @body) @definition.function
(impl_item type: (type_identifier) @owner body: (declaration_list (function_item name: (identifier) @name) @definition.function))
(impl_item type: (generic_type type: (type_identifier) @owner) body: (declaration_list (function_item name: (identifier) @name) @definition.function))
(function_signature_item name: (identifier) @name parameters: (parameters) @parameters) @definition.function
(struct_item name: (type_identifier) @name) @definition.type
(union_item name: (type_identifier) @name) @definition.type
(type_item name: (type_identifier) @name) @definition.type
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name body: (declaration_list) @body) @definition.interface
`;

const RUST_CALLS = `
(call_expression function: (identifier) @callee) @call
(call_expression function: (scoped_identifier path: (identifier) @receiver name: (identifier) @member)) @call
(call_expression function: (field_expression value: (self) @receiver field: (field_identifier) @member)) @call
`;

const RUST_IMPORTS = `
(mod_item !body name: (identifier) @import.source)
(use_declaration argument: (identifier) @import.source)
(use_declaration argument: (scoped_identifier path: (_) @import.source name: (identifier) @import.name))
(use_declaration argument: (use_as_clause path: (scoped_identifier path: (_) @import.source name: (identifier) @import.name) alias: (identifier) @import.alias))
(use_declaration argument: (scoped_use_list path: (_) @import.source list: (use_list (identifier) @import.name)))
(use_declaration argument: (scoped_use_list path: (_) @import.source list: (use_list (use_as_clause path: (identifier) @import.name alias: (identifier) @import.alias))))
`;

const RUST_TYPE_USES = `
(parameters) @type
(function_item return_type: (_) @type)
(field_declaration type: (_) @type)
(impl_item trait: (_) @type)
(let_declaration type: (_) @type)
`;

/** Prelude constructors and functions a bare call may name. */
const RUST_BUILT_INS: ReadonlySet<string> = new Set(['Some', 'Ok', 'Err', 'Box', 'drop', 'Vec', 'String', 'Default']);

const RUST_SOURCE_EXTENSION = '.rs';
const MODULE_FILE = 'mod.rs';
const CRATE_ROOT_FILES = ['lib.rs', 'main.rs'];
const PATH_SEPARATOR = '::';
const CRATE = 'crate';
const SELF_MODULE = 'self';
const SUPER_MODULE = 'super';

/** The directory a file's child modules live in: `src/a.rs` → `src/a`, `src/a/mod.rs` → `src/a`. */
function moduleDirectory(file: string): string {
  const base = posix.basename(file);
  if (base === MODULE_FILE || CRATE_ROOT_FILES.includes(base)) return posix.dirname(file);
  return posix.join(posix.dirname(file), posix.basename(file, RUST_SOURCE_EXTENSION));
}

/** The crate root: the nearest ancestor holding `lib.rs` or `main.rs`, else the nearest `src`. */
function crateRoot(fromFile: string, fileExists: (relPath: string) => boolean): string {
  const ancestors = ancestorDirectories(fromFile);
  for (const directory of ancestors) {
    if (CRATE_ROOT_FILES.some((root) => fileExists(directory === '.' ? root : posix.join(directory, root)))) {
      return directory;
    }
  }
  return ancestors.find((directory) => posix.basename(directory) === 'src') ?? posix.dirname(fromFile);
}

/**
 * `crate::a::b`, `self::x`, `super::y`, or a bare `x` (`mod x;`, a 2018
 * uniform path) → `<base>/a/b.rs` or `<base>/a/b/mod.rs`; a crate from
 * outside (`std::…`) names no project file → null.
 */
export function resolveRustImport(fromFile: string, specifier: string, project: StorylineProject): string | null {
  const segments = specifier.split(PATH_SEPARATOR).map((segment) => segment.trim());
  let base = moduleDirectory(fromFile);
  if (segments[0] === CRATE) {
    base = crateRoot(fromFile, project.fileExists);
    segments.shift();
  } else if (segments[0] === SELF_MODULE) {
    segments.shift();
  } else {
    while (segments[0] === SUPER_MODULE) {
      base = posix.dirname(base);
      segments.shift();
    }
  }
  if (segments.length === 0 || segments.some((segment) => !/^\w+$/.test(segment))) return null;
  const path = posix.join(base, ...segments);
  if (path.startsWith('..')) return null;
  return firstExisting([`${path}${RUST_SOURCE_EXTENSION}`, posix.join(path, MODULE_FILE)], project.fileExists);
}

const PUB = /^pub$/;

export const RUST: StorylineLanguage = {
  id: 'rust',
  displayName: 'Rust',
  extensions: ['.rs'],
  grammar: 'rust',
  queries: { definitions: RUST_DEFINITIONS, calls: RUST_CALLS, imports: RUST_IMPORTS, typeUses: RUST_TYPE_USES },
  typeIdentifierTypes: ['type_identifier'],
  selfReceivers: ['self', 'Self'],
  // `new` is a convention, not a constructor: the struct literal is.
  isConstructor: () => false,
  // `Point(1, 2)` builds a tuple struct — a certain use of it.
  classCallConstructs: true,
  builtIns: RUST_BUILT_INS,
  resolveImport: resolveRustImport,
  isLocalSpecifier: (specifier) => /^(crate|self|super)(::|$)/.test(specifier),
  submoduleSpecifier: (source, name) => `${source}${PATH_SEPARATOR}${name}`,
  // Only consulted for an `impl` of a type declared in another file: its own `pub` is not visible here.
  isExportedName: () => true,
  isPublicMember: () => true,
  isPublicDefinition: ({ span }) => hasChildMatching(span, 'visibility_modifier', PUB),
  docOf: ({ span, lines }) =>
    docCommentAbove(lines, span.startPosition.row, { lineMarkers: ['///'], block: true, skipLine: /^#!?\[/ }),
};
