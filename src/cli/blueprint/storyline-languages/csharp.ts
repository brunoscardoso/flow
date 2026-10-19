/**
 * CODE STORYLINE — C#'s table (plan `story-any-language` phase 2).
 *
 * Classes; structs, records, interfaces and enums as data structures; methods
 * (block or `=>` bodied) and constructors. `this.M()` and a bare `M()` call the
 * type's own members; `new Order()` constructs. `using` names namespaces, which
 * map to no file — a type of the project used by name resolves only by the
 * one-type-per-file convention (`Pricing.cs` beside the file). Exported =
 * `public` (interface members are public); docs are `///` (XML stripped) or
 * `/** *\/` above.
 */

import { docCommentAbove, hasChildMatching, type StorylineLanguage } from './contract.js';
import { siblingTypeFile } from './java.js';

const CSHARP_DEFINITIONS = `
(class_declaration name: (identifier) @name body: (declaration_list) @body) @definition.class
(struct_declaration name: (identifier) @name) @definition.type
(record_declaration name: (identifier) @name) @definition.type
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(method_declaration name: (identifier) @name parameters: (parameter_list) @parameters) @definition.function
(method_declaration name: (identifier) @name body: (_) @body) @definition.function
(constructor_declaration name: (identifier) @name parameters: (parameter_list) @parameters body: (_) @body) @definition.function
`;

const CSHARP_CALLS = `
(invocation_expression function: (identifier) @callee) @call
(invocation_expression function: (member_access_expression expression: "this" @receiver name: (identifier) @member)) @call
(invocation_expression function: (member_access_expression expression: (identifier) @receiver name: (identifier) @member)) @call
(object_creation_expression type: (identifier) @callee) @call
`;

const CSHARP_IMPORTS = `
(using_directive [(identifier) (qualified_name)] @import.source)
`;

const CSHARP_TYPE_USES = `
(parameter type: (_) @type)
(method_declaration returns: (_) @type)
(property_declaration type: (_) @type)
(variable_declaration type: (_) @type)
(base_list) @type
(type_argument_list) @type
`;

const CSHARP_BUILT_INS: ReadonlySet<string> = new Set([
  'nameof', 'typeof', 'sizeof', 'default', 'Object', 'String', 'StringBuilder', 'Exception',
  'ArgumentException', 'ArgumentNullException', 'InvalidOperationException', 'NotImplementedException',
  'NotSupportedException', 'List', 'Dictionary', 'HashSet', 'Task', 'DateTime', 'TimeSpan', 'Guid',
]);

const CSHARP_SOURCE_EXTENSION = '.cs';
const PUBLIC = /^public$/;
const MODIFIER = 'modifier';

export const CSHARP: StorylineLanguage = {
  id: 'csharp',
  displayName: 'C#',
  extensions: ['.cs'],
  grammar: 'c-sharp',
  queries: { definitions: CSHARP_DEFINITIONS, calls: CSHARP_CALLS, imports: CSHARP_IMPORTS, typeUses: CSHARP_TYPE_USES },
  typeIdentifierTypes: ['identifier'],
  selfReceivers: ['this'],
  isConstructor: (member, className) => member === className,
  classCallConstructs: true,
  implicitSelfCalls: true,
  builtIns: CSHARP_BUILT_INS,
  // A namespace is not a path: `using` never names a file.
  resolveImport: () => null,
  isLocalSpecifier: () => false,
  typeFileFor: siblingTypeFile(CSHARP_SOURCE_EXTENSION),
  isExportedName: () => false,
  isPublicMember: () => false,
  isPublicDefinition: ({ span, owner }) => hasChildMatching(span, MODIFIER, PUBLIC) || owner?.kind === 'interface',
  docOf: ({ span, lines }) =>
    docCommentAbove(lines, span.startPosition.row, {
      lineMarkers: ['///', '//'],
      block: true,
      skipLine: /^\[.*\]$/,
      stripMarkup: true,
    }),
};
