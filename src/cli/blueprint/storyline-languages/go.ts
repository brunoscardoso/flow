/**
 * CODE STORYLINE — Go's table (plan `story-any-language` phase 2).
 *
 * Functions; methods declared with a receiver are methods of the receiver's
 * type (`@owner`, which may be declared in another file of the package) and
 * the receiver variable is that method's `self` (`s.save()`); structs and
 * other named types read as `type`, interfaces as `interface`. Imports resolve
 * through `go.mod`'s module path to a package DIRECTORY: `pricing.PriceOf()`
 * is the file in that directory declaring `PriceOf` when the project can be
 * read, and stays plain otherwise. A bare call into another file of the same
 * package is found the same way. Exported = capitalised; docs are the `//`
 * block above.
 */

import { posix } from 'node:path';
import {
  ancestorDirectories,
  directoryTarget,
  docCommentAbove,
  lastSegment,
  type StorylineLanguage,
  type StorylineProject,
} from './contract.js';

const GO_DEFINITIONS = `
(function_declaration
  name: (identifier) @name
  parameters: (parameter_list) @parameters
  body: (block) @body) @definition.function
(method_declaration
  receiver: (parameter_list (parameter_declaration name: (identifier) @self type: (pointer_type (type_identifier) @owner)))
  name: (field_identifier) @name) @definition.function
(method_declaration
  receiver: (parameter_list (parameter_declaration name: (identifier) @self type: (type_identifier) @owner))
  name: (field_identifier) @name) @definition.function
(method_declaration
  receiver: (parameter_list (parameter_declaration type: (pointer_type (type_identifier) @owner)))
  name: (field_identifier) @name) @definition.function
(method_declaration
  receiver: (parameter_list (parameter_declaration type: (type_identifier) @owner))
  name: (field_identifier) @name) @definition.function
(method_declaration
  name: (field_identifier) @name
  parameters: (parameter_list) @parameters
  body: (block) @body) @definition.function
(type_spec name: (type_identifier) @name) @definition.type
(type_spec name: (type_identifier) @name type: (interface_type)) @definition.interface
`;

const GO_CALLS = `
(call_expression function: (identifier) @callee) @call
(call_expression function: (selector_expression operand: (identifier) @receiver field: (field_identifier) @member)) @call
`;

const GO_IMPORTS = `
(import_spec name: (package_identifier) @import.alias path: (interpreted_string_literal (interpreted_string_literal_content) @import.source))
(import_spec !name path: (interpreted_string_literal (interpreted_string_literal_content) @import.source))
`;

const GO_TYPE_USES = `
(function_declaration parameters: (parameter_list) @type)
(function_declaration result: (_) @type)
(method_declaration parameters: (parameter_list) @type)
(method_declaration result: (_) @type)
(field_declaration type: (_) @type)
(method_elem parameters: (parameter_list) @type)
(method_elem result: (_) @type)
`;

/** Predeclared functions and conversions. */
const GO_BUILT_INS: ReadonlySet<string> = new Set([
  'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max', 'min', 'new',
  'panic', 'print', 'println', 'real', 'recover',
  'bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int', 'int8', 'int16', 'int32',
  'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'any',
]);

const GO_MOD = 'go.mod';
const GO_MODULE_LINE = /^\s*module\s+("?)([^\s"]+)\1\s*$/m;

/** The nearest `go.mod` above `fromFile` and the module path it declares, or null. */
function goModuleOf(fromFile: string, project: StorylineProject): { directory: string; module: string } | null {
  for (const directory of ancestorDirectories(fromFile)) {
    const path = directory === '.' ? GO_MOD : posix.join(directory, GO_MOD);
    if (!project.fileExists(path)) continue;
    const module = GO_MODULE_LINE.exec(project.readFile?.(path) ?? '')?.[2] ?? null;
    return module === null ? null : { directory, module };
  }
  return null;
}

/**
 * An import path inside this module (`example.com/shop/internal/pricing`) →
 * the package directory as a directory target (`internal/pricing/`); a
 * standard-library or third-party path → null. Needs the project's `go.mod`.
 */
export function resolveGoImport(fromFile: string, specifier: string, project: StorylineProject): string | null {
  const found = goModuleOf(fromFile, project);
  if (found === null) return null;
  const { directory, module } = found;
  if (specifier !== module && !specifier.startsWith(`${module}/`)) return null;
  const rest = specifier.slice(module.length).replace(/^\//, '');
  const packageDirectory = posix.normalize(posix.join(directory, rest));
  return directoryTarget(packageDirectory);
}

const UPPER_CASE_START = /^\p{Lu}/u;

export const GO: StorylineLanguage = {
  id: 'go',
  displayName: 'Go',
  extensions: ['.go'],
  grammar: 'go',
  queries: { definitions: GO_DEFINITIONS, calls: GO_CALLS, imports: GO_IMPORTS, typeUses: GO_TYPE_USES },
  typeIdentifierTypes: ['type_identifier'],
  selfReceivers: [],
  isConstructor: () => false,
  // `Status(x)` converts to the type — a certain use of it.
  classCallConstructs: true,
  builtIns: GO_BUILT_INS,
  resolveImport: resolveGoImport,
  isLocalSpecifier: () => false,
  moduleBindingName: (source) => lastSegment(source, '/'),
  implicitImports: (fromFile) => [directoryTarget(posix.dirname(fromFile))],
  isExportedName: (name) => UPPER_CASE_START.test(name),
  isPublicMember: (name) => UPPER_CASE_START.test(name),
  docOf: ({ span, lines }) => docCommentAbove(lines, span.startPosition.row, { lineMarkers: ['//'], block: false }),
};
