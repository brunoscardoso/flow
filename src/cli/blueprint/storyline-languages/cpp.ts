/**
 * CODE STORYLINE — C and C++'s table, both read with the C++ grammar (plan
 * `story-any-language` phase 2).
 *
 * Functions (also through pointer/reference declarators); classes; structs,
 * unions and enums as data structures; methods defined in the class body and
 * out of line (`void A::f() {}` → a method of `A`, which may be declared in a
 * header). `this->m()`, a bare `m()` inside a method and `A::m()` call the
 * type's own members; `A(…)` constructs. `#include "x.h"` is a star import
 * resolved beside the file, then under any ancestor (or its `include/`): a
 * name the file cannot place is looked for in the header's declarations
 * (prototypes included) when the project can be read. Members follow the
 * access sections (class private, struct public by default); a `static`
 * free function is file-local; docs are `///`, `//` or `/** *\/` above.
 */

import { posix } from 'node:path';
import type { TreeSitterNode } from '../storyline-treesitter.js';
import {
  ancestorDirectories,
  docCommentAbove,
  firstExisting,
  hasChildMatching,
  projectPath,
  type StorylineLanguage,
  type StorylineProject,
  type VisibilitySubject,
} from './contract.js';

/** The declarator shapes a function's name can sit in: plain, `*f`, `&f`. */
function functionDeclarators(nameField: string): string[] {
  const core = `(function_declarator declarator: ${nameField} parameters: (parameter_list) @parameters)`;
  return [core, `(pointer_declarator declarator: ${core})`, `(reference_declarator ${core})`];
}

const FREE_NAME = '(identifier) @name';
const MEMBER_NAME = '(field_identifier) @name';
const OUT_OF_LINE_NAME = '(qualified_identifier scope: (namespace_identifier) @owner name: (identifier) @name)';
const OUT_OF_LINE_TEMPLATE_NAME =
  '(qualified_identifier scope: (template_type name: (type_identifier) @owner) name: (identifier) @name)';
const DESTRUCTOR_NAME = '(destructor_name) @name';
const OUT_OF_LINE_DESTRUCTOR_NAME =
  '(qualified_identifier scope: (namespace_identifier) @owner name: (destructor_name) @name)';

const CPP_FUNCTION_DEFINITIONS = [FREE_NAME, MEMBER_NAME, OUT_OF_LINE_NAME, OUT_OF_LINE_TEMPLATE_NAME, DESTRUCTOR_NAME, OUT_OF_LINE_DESTRUCTOR_NAME]
  .flatMap(functionDeclarators)
  .map((declarator) => `(function_definition declarator: ${declarator} body: (compound_statement) @body) @definition.function`)
  .join('\n');

const CPP_TYPE_DEFINITIONS = `
(class_specifier name: (type_identifier) @name body: (field_declaration_list) @body) @definition.class
(struct_specifier name: (type_identifier) @name body: (field_declaration_list) @body) @definition.type
(union_specifier name: (type_identifier) @name body: (field_declaration_list) @body) @definition.type
(enum_specifier name: (type_identifier) @name body: (enumerator_list)) @definition.enum
(type_definition declarator: (type_identifier) @name) @definition.type
`;

const CPP_DEFINITIONS = `${CPP_FUNCTION_DEFINITIONS}\n${CPP_TYPE_DEFINITIONS}`;

/** What a header offers another file: definitions plus prototypes. */
const CPP_DECLARATIONS = `${CPP_DEFINITIONS}
(declaration declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(declaration declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function
`;

const CPP_CALLS = `
(call_expression function: (identifier) @callee) @call
(call_expression function: (field_expression argument: (this) @receiver field: (field_identifier) @member)) @call
(call_expression function: (qualified_identifier scope: (namespace_identifier) @receiver name: (identifier) @member)) @call
`;

const CPP_IMPORTS = `
(preproc_include path: (string_literal (string_content) @import.source)) @import.all
`;

const CPP_TYPE_USES = `
(parameter_list) @type
(function_definition type: (_) @type)
(field_declaration type: (_) @type)
(declaration type: (_) @type)
(base_class_clause) @type
`;

const CPP_BUILT_INS: ReadonlySet<string> = new Set([
  'printf', 'fprintf', 'sprintf', 'snprintf', 'puts', 'putchar', 'getchar', 'scanf', 'malloc', 'calloc',
  'realloc', 'free', 'memcpy', 'memmove', 'memset', 'memcmp', 'strlen', 'strcpy', 'strncpy', 'strcmp',
  'strncmp', 'strcat', 'strchr', 'strstr', 'atoi', 'atof', 'abs', 'exit', 'abort', 'assert', 'sizeof',
  'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast', 'move', 'forward', 'swap', 'min', 'max',
  'make_shared', 'make_unique', 'fopen', 'fclose', 'fread', 'fwrite', 'fgets', 'perror',
]);

/** `#include "x.h"` → beside the file, then `<ancestor>/x.h`, then `<ancestor>/include/x.h`. */
export function resolveCppInclude(fromFile: string, specifier: string, project: StorylineProject): string | null {
  const ancestors = ancestorDirectories(fromFile);
  const candidates = [
    projectPath(posix.dirname(fromFile), specifier),
    ...ancestors.map((root) => projectPath(root, specifier)),
    ...ancestors.map((root) => projectPath(root, 'include', specifier)),
  ].filter((candidate): candidate is string => candidate !== null);
  return firstExisting(candidates, project.fileExists);
}

const ACCESS_SPECIFIER = 'access_specifier';
const STATIC = /^static$/;

/** The access section a member sits in: the nearest `public:`/`private:` above it, or the type's default. */
function memberIsPublic(span: TreeSitterNode, ownerKind: VisibilitySubject['owner']): boolean {
  if (span.parent?.type !== 'field_declaration_list') return true; // out of line: its section is in the class
  let current = span.previousNamedSibling;
  while (current !== null) {
    if (current.type === ACCESS_SPECIFIER) return current.text.trim() === 'public';
    current = current.previousNamedSibling;
  }
  return ownerKind?.kind !== 'class';
}

export const CPP: StorylineLanguage = {
  id: 'cpp',
  displayName: 'C/C++',
  extensions: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h', '.c'],
  grammar: 'cpp',
  queries: {
    definitions: CPP_DEFINITIONS,
    calls: CPP_CALLS,
    imports: CPP_IMPORTS,
    typeUses: CPP_TYPE_USES,
    declarations: CPP_DECLARATIONS,
  },
  typeIdentifierTypes: ['type_identifier'],
  selfReceivers: ['this'],
  isConstructor: (member, className) => member === className,
  classCallConstructs: true,
  implicitSelfCalls: true,
  builtIns: CPP_BUILT_INS,
  resolveImport: resolveCppInclude,
  isLocalSpecifier: () => true,
  isExportedName: () => true,
  isPublicMember: () => true,
  isPublicDefinition: ({ span, owner }) =>
    owner === null ? !hasChildMatching(span, 'storage_class_specifier', STATIC) : memberIsPublic(span, owner),
  docOf: ({ span, lines }) =>
    docCommentAbove(lines, span.startPosition.row, { lineMarkers: ['///', '//!', '//'], block: true, skipLine: /^template\s*</ }),
};
