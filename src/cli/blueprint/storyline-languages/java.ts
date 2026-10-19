/**
 * CODE STORYLINE — Java's table (plan `story-any-language` phase 2).
 *
 * Classes; interfaces, enums and records as data structures; methods and
 * constructors (a constructor is the member named like its class). `this.m()`
 * and a bare `m()` inside a method call the class's own members; `new
 * Order()` constructs. `import a.b.Pricing;` resolves to `a/b/Pricing.java`
 * under any ancestor of the file (its source root); a class of the same
 * package used without import resolves to `Pricing.java` beside the file.
 * Exported = `public` (interface members are public); docs are `/** *\/` or
 * `//` above.
 */

import { posix } from 'node:path';
import {
  ancestorDirectories,
  docCommentAbove,
  firstExisting,
  hasChildMatching,
  lastSegment,
  type StorylineLanguage,
  type StorylineProject,
} from './contract.js';

const JAVA_DEFINITIONS = `
(class_declaration name: (identifier) @name body: (class_body) @body) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(record_declaration name: (identifier) @name) @definition.type
(annotation_type_declaration name: (identifier) @name) @definition.interface
(method_declaration name: (identifier) @name parameters: (formal_parameters) @parameters) @definition.function
(method_declaration name: (identifier) @name body: (block) @body) @definition.function
(constructor_declaration name: (identifier) @name parameters: (formal_parameters) @parameters body: (constructor_body) @body) @definition.function
(compact_constructor_declaration name: (identifier) @name body: (block) @body) @definition.function
`;

const JAVA_CALLS = `
(method_invocation !object name: (identifier) @callee) @call
(method_invocation object: (this) @receiver name: (identifier) @member) @call
(method_invocation object: (identifier) @receiver name: (identifier) @member) @call
(object_creation_expression type: (type_identifier) @callee) @call
`;

const JAVA_IMPORTS = `
(import_declaration (scoped_identifier) @import.source)
`;

const JAVA_TYPE_USES = `
(type_identifier) @type
`;

/** `java.lang` classes and common JDK types a file uses without importing. */
const JAVA_BUILT_INS: ReadonlySet<string> = new Set([
  'Object', 'String', 'StringBuilder', 'StringBuffer', 'Integer', 'Long', 'Double', 'Float', 'Short', 'Byte',
  'Boolean', 'Character', 'Math', 'System', 'Thread', 'Runnable', 'Exception', 'RuntimeException', 'Error',
  'IllegalArgumentException', 'IllegalStateException', 'NullPointerException', 'UnsupportedOperationException',
  'IndexOutOfBoundsException', 'ArithmeticException', 'Throwable', 'Iterable', 'Comparable', 'Record', 'Enum',
  'Void', 'Number', 'Class', 'ClassLoader', 'Process', 'ProcessBuilder', 'Runtime', 'StackTraceElement',
  'ThreadLocal', 'InterruptedException', 'CloneNotSupportedException', 'AssertionError',
]);

const JAVA_SOURCE_EXTENSION = '.java';
const PACKAGE_SEPARATOR = '.';

/** `com.acme.Pricing` → `<root>/com/acme/Pricing.java` for the nearest ancestor root that has it, or null. */
export function resolveJavaImport(fromFile: string, specifier: string, project: StorylineProject): string | null {
  const path = `${specifier.split(PACKAGE_SEPARATOR).join('/')}${JAVA_SOURCE_EXTENSION}`;
  const candidates = ancestorDirectories(fromFile).map((root) => (root === '.' ? path : posix.join(root, path)));
  return firstExisting(candidates, project.fileExists);
}

const TYPE_NAME = /^\p{Lu}\w*$/u;

/** A same-package type: `<Name>.java` beside the file (the language's own one-public-type-per-file rule). */
export function siblingTypeFile(
  extension: string,
): (fromFile: string, name: string, fileExists: (relPath: string) => boolean) => string | null {
  return (fromFile, name, fileExists) => {
    if (!TYPE_NAME.test(name)) return null;
    const candidate = posix.join(posix.dirname(fromFile), `${name}${extension}`);
    return candidate !== fromFile && fileExists(candidate) ? candidate : null;
  };
}

const PUBLIC = /\bpublic\b/;
const MODIFIERS = 'modifiers';

export const JAVA: StorylineLanguage = {
  id: 'java',
  displayName: 'Java',
  extensions: ['.java'],
  grammar: 'java',
  queries: { definitions: JAVA_DEFINITIONS, calls: JAVA_CALLS, imports: JAVA_IMPORTS, typeUses: JAVA_TYPE_USES },
  typeIdentifierTypes: ['type_identifier'],
  selfReceivers: ['this'],
  isConstructor: (member, className) => member === className,
  classCallConstructs: true,
  implicitSelfCalls: true,
  builtIns: JAVA_BUILT_INS,
  resolveImport: resolveJavaImport,
  isLocalSpecifier: () => false,
  moduleBindingName: (source) => lastSegment(source, PACKAGE_SEPARATOR),
  typeFileFor: siblingTypeFile(JAVA_SOURCE_EXTENSION),
  isExportedName: () => false,
  isPublicMember: () => false,
  isPublicDefinition: ({ span, owner }) =>
    hasChildMatching(span, MODIFIERS, PUBLIC) || owner?.kind === 'interface',
  docOf: ({ span, lines }) =>
    docCommentAbove(lines, span.startPosition.row, { lineMarkers: ['//'], block: true }),
};
