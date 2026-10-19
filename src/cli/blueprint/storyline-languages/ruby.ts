/**
 * CODE STORYLINE — Ruby's table (plan `story-any-language` phase 2).
 *
 * `def` (and `def self.x`) methods, `class` and `module` as classes. `self.m`,
 * a bare `m(…)` inside a method and `Klass.m` call the type's own members;
 * `Klass.new` constructs (the arrow goes to `initialize`). `require_relative`
 * is a star import: a constant or method the file cannot place is looked for
 * in the required file when the project can be read. Methods are public until
 * a bare `private`/`protected`; docs are the `#` block above.
 */

import { posix } from 'node:path';
import type { TreeSitterNode } from '../storyline-treesitter.js';
import { docCommentAbove, projectPath, type StorylineLanguage, type StorylineProject } from './contract.js';

const RUBY_DEFINITIONS = `
(method name: (_) @name parameters: (method_parameters) @parameters) @definition.function
(method name: (_) @name body: (_) @body) @definition.function
(method name: (_) @name) @definition.function
(singleton_method name: (_) @name parameters: (method_parameters) @parameters) @definition.function
(singleton_method name: (_) @name body: (_) @body) @definition.function
(singleton_method name: (_) @name) @definition.function
(class name: (constant) @name) @definition.class
(module name: (constant) @name) @definition.class
`;

const RUBY_CALLS = `
(call !receiver method: (identifier) @callee) @call
(call receiver: (self) @receiver method: (identifier) @member) @call
(call receiver: (constant) @receiver method: (identifier) @member) @call
`;

const RUBY_IMPORTS = `
(call
  method: (identifier) @_require
  arguments: (argument_list (string (string_content) @import.source))
  (#eq? @_require "require_relative")) @import.all
`;

const RUBY_BUILT_INS: ReadonlySet<string> = new Set([
  'puts', 'print', 'p', 'pp', 'require', 'require_relative', 'raise', 'fail', 'loop', 'lambda', 'proc', 'format',
  'sprintf', 'printf', 'sleep', 'rand', 'srand', 'gets', 'catch', 'throw', 'exit', 'abort', 'at_exit',
  'attr_accessor', 'attr_reader', 'attr_writer', 'include', 'extend', 'prepend', 'private', 'public', 'protected',
  'module_function', 'private_constant', 'define_method', 'block_given?', 'binding', 'caller', 'freeze',
  'Integer', 'Float', 'String', 'Array', 'Hash', 'Rational', 'Complex', 'new', 'super', 'instance_variable_get',
  'instance_variable_set', 'respond_to?', 'send', 'public_send', 'is_a?', 'kind_of?', 'tap', 'then',
]);

const RUBY_SOURCE_EXTENSION = '.rb';

/** `require_relative 'x'` → `x.rb` beside the file (the extension is optional in the source). */
export function resolveRubyRequire(fromFile: string, specifier: string, project: StorylineProject): string | null {
  const withExtension = specifier.endsWith(RUBY_SOURCE_EXTENSION) ? specifier : `${specifier}${RUBY_SOURCE_EXTENSION}`;
  const candidate = projectPath(posix.dirname(fromFile), withExtension);
  return candidate !== null && project.fileExists(candidate) ? candidate : null;
}

const VISIBILITY_WORDS = ['private', 'protected', 'public'];
const PUBLIC = 'public';

/** A method is public unless a bare `private`/`protected` line comes before it in its class. */
function rubyMethodIsPublic(span: TreeSitterNode): boolean {
  let current = span.previousNamedSibling;
  while (current !== null) {
    if (current.type === 'identifier' && VISIBILITY_WORDS.includes(current.text)) return current.text === PUBLIC;
    current = current.previousNamedSibling;
  }
  return true;
}

const RUBY_CONSTRUCTOR = 'initialize';

export const RUBY: StorylineLanguage = {
  id: 'ruby',
  displayName: 'Ruby',
  extensions: ['.rb'],
  grammar: 'ruby',
  queries: { definitions: RUBY_DEFINITIONS, calls: RUBY_CALLS, imports: RUBY_IMPORTS },
  typeIdentifierTypes: ['constant'],
  selfReceivers: ['self'],
  isConstructor: (member) => member === RUBY_CONSTRUCTOR,
  classCallConstructs: false,
  constructsVia: 'new',
  implicitSelfCalls: true,
  builtIns: RUBY_BUILT_INS,
  resolveImport: resolveRubyRequire,
  isLocalSpecifier: () => true,
  isExportedName: () => true,
  isPublicMember: () => true,
  isPublicDefinition: ({ span, owner }) => owner === null || rubyMethodIsPublic(span),
  docOf: ({ span, lines }) => docCommentAbove(lines, span.startPosition.row, { lineMarkers: ['#'], block: false }),
};
