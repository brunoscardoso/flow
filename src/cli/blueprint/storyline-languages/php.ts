/**
 * CODE STORYLINE — PHP's table (plan `story-any-language` phase 2).
 *
 * Functions; classes and traits as classes; interfaces and enums as data
 * structures; methods (`__construct` constructs). `$this->m()`, `self::m()`
 * and `static::m()` call the class's own members; `Order::m()` one of the
 * file's classes or an imported one; `new Order()` constructs. `use
 * App\Models\Order;` resolves only when a PSR-4 path does — the
 * `composer.json` `autoload.psr-4` map when the project can be read, else the
 * usual layouts (`App/Models/Order.php`, `app/Models/Order.php`,
 * `src/Models/Order.php`). `require`/`include` of a literal path are star
 * imports. Members are public unless `private`/`protected`; docs are `/** *\/`
 * above.
 */

import { posix } from 'node:path';
import {
  ancestorDirectories,
  docCommentAbove,
  firstExisting,
  hasChildMatching,
  lastSegment,
  projectPath,
  type StorylineLanguage,
  type StorylineProject,
} from './contract.js';

const PHP_DEFINITIONS = `
(function_definition name: (name) @name parameters: (formal_parameters) @parameters body: (compound_statement) @body) @definition.function
(class_declaration name: (name) @name body: (declaration_list) @body) @definition.class
(trait_declaration name: (name) @name) @definition.class
(interface_declaration name: (name) @name) @definition.interface
(enum_declaration name: (name) @name) @definition.enum
(method_declaration name: (name) @name parameters: (formal_parameters) @parameters) @definition.function
(method_declaration name: (name) @name body: (compound_statement) @body) @definition.function
`;

const PHP_CALLS = `
(function_call_expression function: (name) @callee) @call
(member_call_expression object: (variable_name) @receiver name: (name) @member) @call
(scoped_call_expression scope: (relative_scope) @receiver name: (name) @member) @call
(scoped_call_expression scope: (name) @receiver name: (name) @member) @call
(object_creation_expression (name) @callee) @call
`;

/** One pattern per include form: a nested alternation matches nothing in this runtime. */
const PHP_INCLUDE_FORMS = ['require_expression', 'require_once_expression', 'include_expression', 'include_once_expression'];

const PHP_IMPORTS = `
(namespace_use_clause (qualified_name) @import.source alias: (name) @import.alias)
(namespace_use_clause !alias (qualified_name) @import.source)
(namespace_use_clause !alias (name) @import.source)
${PHP_INCLUDE_FORMS.map(
  (form) => `(${form} (string (string_content) @import.source)) @import.all
(${form} (encapsed_string (string_content) @import.source)) @import.all
(${form} (binary_expression right: (string (string_content) @import.source))) @import.all`,
).join('\n')}
`;

const PHP_TYPE_USES = `
(named_type) @type
(base_clause) @type
(class_interface_clause) @type
`;

const PHP_BUILT_INS: ReadonlySet<string> = new Set([
  'array_map', 'array_filter', 'array_reduce', 'array_keys', 'array_values', 'array_merge', 'array_key_exists',
  'array_search', 'array_slice', 'array_splice', 'array_unique', 'array_push', 'array_pop', 'array_shift',
  'count', 'in_array', 'implode', 'explode', 'strlen', 'strtolower', 'strtoupper', 'substr', 'str_replace',
  'str_contains', 'str_starts_with', 'str_ends_with', 'sprintf', 'printf', 'trim', 'json_encode', 'json_decode',
  'isset', 'unset', 'empty', 'is_array', 'is_string', 'is_int', 'is_null', 'is_numeric', 'intval', 'floatval',
  'strval', 'var_dump', 'print_r', 'echo', 'die', 'exit', 'compact', 'extract', 'func_get_args', 'call_user_func',
  'define', 'defined', 'file_get_contents', 'file_put_contents', 'file_exists', 'dirname', 'basename', 'time',
  'date', 'microtime', 'preg_match', 'preg_replace', 'preg_split', 'max', 'min', 'abs', 'round', 'floor', 'ceil',
  'sort', 'usort', 'ksort', 'array_walk', 'range', 'method_exists', 'property_exists', 'get_class',
  'Exception', 'InvalidArgumentException', 'RuntimeException', 'LogicException', 'DateTime', 'DateTimeImmutable',
  'ArrayObject', 'stdClass',
]);

const PHP_SOURCE_EXTENSION = '.php';
const NAMESPACE_SEPARATOR = '\\';
const COMPOSER_FILE = 'composer.json';
/** The layouts a namespace root is conventionally kept in when there is no readable `composer.json`. */
const CONVENTIONAL_ROOTS = ['src', 'lib', 'app'];

/** The `autoload` / `autoload-dev` PSR-4 map of a `composer.json` text: namespace prefix → directories. */
function psr4Map(composerText: string): Array<[string, string[]]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(composerText);
  } catch {
    // A composer.json that does not parse maps nothing; the conventional layouts still apply.
    return [];
  }
  const sections = ['autoload', 'autoload-dev'].map((key) => (parsed as Record<string, unknown> | null)?.[key]);
  const pairs: Array<[string, string[]]> = [];
  for (const section of sections) {
    const map = (section as Record<string, unknown> | undefined)?.['psr-4'];
    if (map === null || typeof map !== 'object') continue;
    for (const [prefix, value] of Object.entries(map as Record<string, unknown>)) {
      const directories = (Array.isArray(value) ? value : [value]).filter((entry): entry is string => typeof entry === 'string');
      pairs.push([prefix, directories]);
    }
  }
  return pairs;
}

function resolveNamespace(fromFile: string, specifier: string, project: StorylineProject): string | null {
  const qualified = specifier.replace(/^\\+/, '');
  const segments = qualified.split(NAMESPACE_SEPARATOR).filter((segment) => segment !== '');
  if (segments.length === 0) return null;
  for (const directory of ancestorDirectories(fromFile)) {
    const composerPath = directory === '.' ? COMPOSER_FILE : posix.join(directory, COMPOSER_FILE);
    if (!project.fileExists(composerPath)) continue;
    const text = project.readFile?.(composerPath) ?? null;
    if (text === null) break;
    for (const [prefix, directories] of psr4Map(text)) {
      if (!`${qualified}${NAMESPACE_SEPARATOR}`.startsWith(prefix) || prefix === '') continue;
      const rest = qualified.slice(prefix.length).split(NAMESPACE_SEPARATOR).join('/');
      const candidates = directories
        .map((root) => projectPath(directory, root, `${rest}${PHP_SOURCE_EXTENSION}`))
        .filter((candidate): candidate is string => candidate !== null);
      const found = firstExisting(candidates, project.fileExists);
      if (found !== null) return found;
    }
    break;
  }
  const path = segments.join('/');
  const [first = '', ...rest] = segments;
  const tail = rest.join('/');
  const candidates = [
    `${path}${PHP_SOURCE_EXTENSION}`,
    `${first.charAt(0).toLowerCase()}${first.slice(1)}/${tail}${PHP_SOURCE_EXTENSION}`,
    ...CONVENTIONAL_ROOTS.map((root) => `${root}/${tail}${PHP_SOURCE_EXTENSION}`),
  ];
  return rest.length === 0 ? firstExisting([candidates[0] ?? ''], project.fileExists) : firstExisting(candidates, project.fileExists);
}

/**
 * A `require`/`include` path (relative to the file, a leading `/` meaning
 * `__DIR__ . '/…'`) or a `use` namespace (PSR-4) → the project file, or null.
 */
export function resolvePhpImport(fromFile: string, specifier: string, project: StorylineProject): string | null {
  if (specifier.endsWith(PHP_SOURCE_EXTENSION) || specifier.includes('/')) {
    const relative = specifier.replace(/^\/+/, '');
    const candidates = [projectPath(posix.dirname(fromFile), relative), projectPath(relative)].filter(
      (candidate): candidate is string => candidate !== null,
    );
    return firstExisting(candidates, project.fileExists);
  }
  return resolveNamespace(fromFile, specifier, project);
}

const HIDDEN = /^(private|protected)$/;

export const PHP: StorylineLanguage = {
  id: 'php',
  displayName: 'PHP',
  extensions: ['.php'],
  grammar: 'php',
  queries: { definitions: PHP_DEFINITIONS, calls: PHP_CALLS, imports: PHP_IMPORTS, typeUses: PHP_TYPE_USES },
  typeIdentifierTypes: ['name'],
  selfReceivers: ['$this', 'self', 'static'],
  isConstructor: (member) => member === '__construct',
  classCallConstructs: true,
  builtIns: PHP_BUILT_INS,
  resolveImport: resolvePhpImport,
  isLocalSpecifier: (specifier) => specifier.endsWith(PHP_SOURCE_EXTENSION),
  moduleBindingName: (source) => lastSegment(source, NAMESPACE_SEPARATOR),
  isExportedName: () => true,
  isPublicMember: () => true,
  isPublicDefinition: ({ span, owner }) => owner === null || !hasChildMatching(span, 'visibility_modifier', HIDDEN),
  docOf: ({ span, lines }) =>
    docCommentAbove(lines, span.startPosition.row, { lineMarkers: ['//', '#'], block: true, skipLine: /^#\[/ }),
};
