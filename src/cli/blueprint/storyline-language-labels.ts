/**
 * CODE STORYLINE — which files can be read as a story, and what each language
 * is called (plan `story-any-language` phase 3).
 *
 * A PURE module with no imports, compiled by both sides (the precedent of
 * `understood.ts`): the app re-exports it (`app/src/shared/storyline-languages.ts`)
 * so the board knows which files open as a story and what to call a story's
 * language, without pulling in the CLI's readers. The CLI's own registry —
 * the compiler's extensions in `storyline.ts` and the tree-sitter tables in
 * `storyline-languages.ts` — is the source of truth; `storyline-language-labels.test.ts`
 * fails the moment the two disagree.
 */

export interface StorylineLanguageLabel {
  /** The answer's `language` (`python`). */
  id: string;
  /** What the reader calls it (`Python`). */
  displayName: string;
  /** Lower-case, with the dot. */
  extensions: readonly string[];
}

/** The language a part mixing several is answered as. */
export const MIXED_STORYLINE_LANGUAGE = 'mixed';

/** Every language a story can be read in. */
export const STORYLINE_LANGUAGE_LABELS: readonly StorylineLanguageLabel[] = [
  { id: 'typescript', displayName: 'TypeScript', extensions: ['.ts', '.mts', '.cts', '.tsx'] },
  { id: 'javascript', displayName: 'JavaScript', extensions: ['.js', '.mjs', '.cjs', '.jsx'] },
  { id: 'python', displayName: 'Python', extensions: ['.py', '.pyi'] },
  { id: 'go', displayName: 'Go', extensions: ['.go'] },
  { id: 'rust', displayName: 'Rust', extensions: ['.rs'] },
  { id: 'java', displayName: 'Java', extensions: ['.java'] },
  { id: 'csharp', displayName: 'C#', extensions: ['.cs'] },
  { id: 'ruby', displayName: 'Ruby', extensions: ['.rb'] },
  { id: 'php', displayName: 'PHP', extensions: ['.php'] },
  { id: 'cpp', displayName: 'C/C++', extensions: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h', '.c'] },
  { id: 'bash', displayName: 'Bash', extensions: ['.sh', '.bash'] },
];

const EXTENSIONS: ReadonlySet<string> = new Set(STORYLINE_LANGUAGE_LABELS.flatMap((label) => label.extensions));

/** True when a path's extension is one a story can be read from. */
export function isStorylineExtensionPath(path: string): boolean {
  const tail = path.slice(path.lastIndexOf('/') + 1);
  const dot = tail.lastIndexOf('.');
  if (dot <= 0) return false;
  return EXTENSIONS.has(tail.slice(dot).toLowerCase());
}

/**
 * What to call a story's language in its header — null for TypeScript and
 * JavaScript (the story's default, never badged) and for an id nobody knows.
 */
export function storylineLanguageBadge(language: string): string | null {
  if (language === 'typescript' || language === 'javascript') return null;
  if (language === MIXED_STORYLINE_LANGUAGE) return 'Mixed languages';
  return STORYLINE_LANGUAGE_LABELS.find((label) => label.id === language)?.displayName ?? null;
}
